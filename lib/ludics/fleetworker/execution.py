"""``execution``: the anchor's execution registry, and the conclusions read off a run on its box
(fleet-worker.sh's ``cmd_execution``, ``execution_listing``, ``execution_host_of``,
``conclude_from_run``, ``conclude_from_bg_run``, ``endpoint_map``, ``execution_refresh``).

The registry itself is ``ludics.fleetworker.registry``: its SOURCE travels to the anchor and runs
there from stdin under a Python >= 3.12 the far side finds (``FIND_PYTHON``), inside the lease
lock for every action but ``list``; its argv is ``root action coordinator token payload boxes
[slots map anchor lab]``. The rules it enforces are its own header's.

``execution slot`` and ``execution hold`` take no registry lock and run on THIS box: they are
``ludics.fleetworker.slot``.

The far sides of ``conclude --from-run`` and ``--from-bg-run`` stay the shell's, verbatim: they
run on the box that holds the run, and read its record with the tools that wrote it.

Every commit a payload names is checked before the anchor is asked (ludics-lite#561): what is read,
where, and the outcomes are ``ludics.fleetworker.revision``'s header.
"""

import json
import os
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, assert_never, cast

from ludics import cli
from ludics.fleetworker import revision
from ludics.fleetworker.config import Config
from ludics.fleetworker.farside import FLEET_PYTHON
from ludics.fleetworker.identity import check_identity, coordinator_id, die, my_token
from ludics.fleetworker.lease import LEASE_MUTATION
from ludics.fleetworker.preflight import refresh_box
from ludics.fleetworker.transport import Done, err, fleet_name, prelude, run, run_on, substitution

REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.py")

# The far side's interpreter: the first that reports >= 3.12, in scripts/py's order
# (farside.FLEET_PYTHON, which the preflight's probe of a box shares).
FIND_PYTHON = (
    FLEET_PYTHON
    + 'py=$(fleet_python) || { echo "EXECUTION REFUSED: no Python >= 3.12 on $BOX to run the execution registry'
    + " (scripts/py's probe; install one, or name it in LUDICS_PY_CANDIDATES)\" >&2; exit 1; }\n"
)


def registry_command(source: str) -> str:
    """The far side's last lines: the registry's source as the program, its argv after it."""
    return (
        FIND_PYTHON
        + "\"$py\" -X utf8 -P - \"$ANCHOR_STATE\" \"$@\" <<'FLEET_EXECUTION_PY'\n"
        + source
        + "\nFLEET_EXECUTION_PY\n"
    )


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
    script = prelude(cfg, cfg.anchor) + "shift 3\n" + registry_command(registry_source())
    args = ["EXECUTION", "x", "x", "list", "x", "x", "{}", cfg.boxes, cfg.slots]
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

# Far side of `conclude --from-run`, on the execution box: read a finished test-run.sh record
# (OCANNL's `tools/test-run.sh`: `exit`, `log`, `wt` and `cmd` under the run directory) and the
# checkout's head, and refuse anything short of a published verdict with no process left. Since
# ocannl-staging#808 the record also names the source it ran, as launch-time facts: `head` and
# `dirty`, `dirty` written first, so the writer leaves both or neither (ludics-lite#438). Args:
# run-dir, reported sha. Prints `exit=`, `wt=`, `head=`, `record=` lines, or one FROM-RUN REFUSED line.
FROM_RUN = r"""dir="$1" sha="$2"
refuse() { echo "FROM-RUN REFUSED: $*"; exit 1; }
[ -d "$dir" ] || refuse "no run directory $dir on $BOX"
for f in exit log wt cmd; do
  [ -f "$dir/$f" ] || refuse "$dir has no $f (the run is unfinished, died without a verdict, or is not a test-run.sh record)"
done
code=$(head -n1 "$dir/exit"); case "$code" in ''|*[!0-9]*) refuse "$dir/exit holds '$code', not a status" ;; esac
wt=$(head -n1 "$dir/wt"); [ -d "$wt" ] || refuse "recorded worktree $wt is gone"
# The project's runner is the authority on "published and no process remains" (exit 0; 3 still
# running, 1 died); without it, the supervisor pid must be gone.
if [ -x "$wt/tools/test-run.sh" ]; then
  (cd "$wt" && tools/test-run.sh status "$dir" >/dev/null 2>&1); st=$?
  [ "$st" -eq 0 ] || refuse "tools/test-run.sh status $dir exit $st: not a finished run"
elif [ -s "$dir/pid" ] && kill -0 "$(head -n1 "$dir/pid")" 2>/dev/null; then
  refuse "supervisor pid $(head -n1 "$dir/pid") of $dir is still alive"
fi
if [ -e "$dir/head" ] && [ -e "$dir/dirty" ]; then
  [ -f "$dir/head" ] && [ -f "$dir/dirty" ] || refuse "$dir/head or $dir/dirty is not a regular file: a malformed record"
  rhead=$(cat "$dir/head")
  case "$rhead" in ''|*[!0-9a-f]*) refuse "$dir/head holds '$rhead', not one commit ID: a malformed record" ;; esac
  [ "$rhead" = "$sha" ] || refuse "$dir/head records $rhead as the revision launched, but the reported revision is $sha: this run is evidence for $rhead, not $sha"
  if [ -s "$dir/dirty" ]; then
    n=$(grep -c '' "$dir/dirty")
    refuse "$dir/dirty lists $n uncommitted path(s) at launch: the run tested $sha plus those edits, so it is not evidence for $sha; conclude it with a JSON payload whose evidence says so"
  fi
  record=launch
elif [ -e "$dir/head" ]; then
  refuse "$dir has a head but no dirty: a malformed record (test-run.sh writes dirty first, so both or neither)"
elif [ -e "$dir/dirty" ]; then
  refuse "$dir has a dirty but no head: a malformed record (test-run.sh writes head after dirty, so both or neither)"
else
  record=none
fi
head=$(git -C "$wt" rev-parse --verify HEAD^{commit} 2>/dev/null) || refuse "cannot read HEAD of $wt"
# With no launch record the revision that ran is the coordinator's to name (--sha, from the
# worker's result line). Either way the checkout has to KNOW that commit, and its head now is
# reported so a conclusion over a moved checkout says so in its evidence.
git -C "$wt" cat-file -e "$sha^{commit}" 2>/dev/null || refuse "$wt does not contain the reported revision $sha"
printf 'exit=%s\nwt=%s\nhead=%s\nrecord=%s\n' "$code" "$wt" "$head" "$record"
"""

# Far side of `conclude --from-bg-run`, on the box that holds the directory: bg-run.sh's own `wait
# <dir> --within 0` gives the verdict, so the directory contract keeps one reader. The
# coordinator's copy of bg-run.sh travels in this script, so the far box's skills checkout cannot
# read the directory with another version. The one thing read past `wait` is the runner's own exit
# sentinel in `log`, a fail-closed allowlist: a whole line `exit: <status>` or `<name>: exit:
# <status>`, the name [A-Za-z0-9._-]+ and the status 0-255 without leading zeros; the LAST such
# line wins. Prints `status=rc`, `rc=` and `sentinel=` lines, or one FROM-BG-RUN REFUSED line.
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
  6) refuse "bg-run.sh wait: $said -- start refused this directory, so an rc there may be an earlier run's" ;;
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


def conclude_from_run(cfg: Config, run_dir: str, request: str, box: str, sha: str, evidence: str) -> Conclusion:
    """The conclude payload read off a finished test-run.sh record on the box. The box is the
    reservation's execution host: the payload names it and the registry checks it, so a record
    read on the wrong machine cannot conclude another box's assignment."""
    done = run_on(cfg, box, prelude(cfg, box) + FROM_RUN, [run_dir, sha], capture=True)
    if done.unreachable:
        return Refusal(f"FROM-RUN UNREACHABLE {box}: nothing concluded", 4)
    facts = substitution(done.out)
    if done.rc != 0:
        return Refusal(facts, 1)
    code, wt, head = facts_of(facts, "exit"), facts_of(facts, "wt"), facts_of(facts, "head")
    record = facts_of(facts, "record")
    if not (SHA40.fullmatch(head) and code and wt and record in ("launch", "none")):
        return Refusal(f"FROM-RUN REFUSED: unreadable record facts from {box}: {facts}", 1)
    # test-run.sh's exit vocabulary: 142 the cap, 129/130/137/143 a signal; every other nonzero
    # (dune's own 1, a refused invocation, 126/127 toolchain) is a failed run.
    verdict = run_verdict(code, timeout_codes=("142",))
    if not evidence:
        evidence = f"test-run.sh record {run_dir} on {box}: exit {code} published, no process remains"
    if record == "launch":
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
    source: str = "as reported by the worker",
) -> Conclusion:
    """The conclude payload read off a bg-run.sh directory. The verdict mapping:
      - the code is the runner's own sentinel when the log carries one and it is nonzero, else rc --
        so a pass needs BOTH rc 0 and no nonzero sentinel;
      - 0 pass; 124 (timeout(1)) and 142 (test-run.sh's cap) timeout; 129/130/137/143 (a signal)
        cancelled; anything else fail;
      - bg-run's DIED is refused, not mapped, as are RUNNING, STARTING and REFUSED.
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
    if facts_of(facts, "status") != "rc":
        return Refusal(f"FROM-BG-RUN REFUSED: unreadable run facts from {box}: {facts}", 1)
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
    if not evidence:
        evidence = f"{note}; revision {sha} {source}"
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

LIST_USAGE = "execution list: expected --active or --compact"
USAGE = (
    "execution: list, slot -- <command>, hold -- <command>, run|reserve|dispatch|record|reconcile|conclude"
    " <json-file>, window <box> <json-file>, or conclude --from-run|--from-bg-run <run-dir> --request <id>"
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
        cli.say(f"EXECUTION UNREACHABLE {cfg.anchor}: cannot read request {request}'s repository to check its revision")
        raise cli.Exit(4)
    records = records_of(done.out) if done.rc == 0 else None
    if records is None:
        cli.emit(substitution(done.out))
        cli.say("EXECUTION REFUSED: the anchor's registry could not be read")
        raise cli.Exit(1)
    return record_of(records, request)


def checked_evidence(cfg: Config, text: str, observed_from: str) -> str:
    """A record, reconcile or conclude payload whose ``observed_sha`` resolves in the request's
    repository, or with it read off ``observed_from`` (conclude only). A payload the registry will
    refuse on shape anyway (not an object, no request_id, a SHA of the wrong shape) passes unread."""
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
    if not (isinstance(request, str) and request and (shaped or observed_from)):
        return text
    record = record_to_check(cfg, request)
    if record is None:
        return text
    if not observed_from:
        fail(revision.commit_refusal(jq_text(field(record, "request", "repository")), "observed_sha", cast(str, sha)))
        return text
    host = jq_text(field(record, "request", "execution_host"))
    head = observed_head(cfg, host, observed_from)
    if isinstance(head, Refusal):
        concluded(head)
        return text
    if "observed_sha" in data and sha != head:
        cli.say(
            f"EXECUTION REFUSED: the payload's observed_sha {jq_text(sha)} is not HEAD {head} of"
            f" {observed_from} on {host}; drop it and let --observed-from record the checkout's"
        )
        raise cli.Exit(1)
    data["observed_sha"] = head
    data.setdefault("remote_checkout", observed_from)
    if isinstance(data.get("evidence"), str) and data["evidence"].strip():
        data["evidence"] += f"; observed_sha read as HEAD of {observed_from} on {host}"
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def conclude_payload(cfg: Config, args: list[str]) -> str:
    """``conclude <json-file> [--observed-from <checkout>]``."""
    values = flag_values(args[2:], ("--observed-from",), CONCLUDE_USAGE)
    payload = read_payload("conclude", args[:2])
    observed_from = values.get("--observed-from", "")
    if observed_from:
        checkout_arg(observed_from, "")
    check_identity(cfg)
    return checked_evidence(cfg, payload, observed_from)


def checked_request(payload: str, action: str) -> None:
    """A reserve, run or window request whose requested_revision names only commits that resolve.
    A payload that does not parse is left to the registry, which refuses it."""
    try:
        decoded: Any = json.loads(payload)
    except ValueError:
        return
    if action == "window":
        decoded = cast(dict[str, Any], decoded).get("request") if isinstance(decoded, dict) else None
    fail(revision.request_refusal(decoded))


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
    # named, which must resolve in the request's repository (ludics-lite#561).
    source = "as reported by the worker"
    if observed_from:
        head = observed_head(cfg, host, observed_from)
        if isinstance(head, Refusal):
            return concluded(head)
        if sha and sha != head:
            cli.say(f"EXECUTION REFUSED: --sha {sha} is not HEAD {head} of {observed_from} on {host}; give one of them")
            raise cli.Exit(1)
        sha, source = head, f"read as HEAD of {observed_from} on {host}"
    else:
        fail(revision.commit_refusal(jq_text(field(record, "request", "repository")), "--sha", sha))
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


def window_payload(args: list[str]) -> str:
    if len(args) != 3 or not args[1] or not os.access(args[2], os.R_OK):
        die("execution window <box> <measurement reserve.json>: a box and a readable JSON file required")
    try:
        with open(args[2], encoding="utf-8", errors="surrogateescape") as f:
            text = f.read()
    except OSError:
        die(f"execution window: {args[2]} is not a JSON reservation")
    # jq's reading: a stream of JSON values, one wrapped line each. No value prints nothing, and
    # several print several lines; the registry refuses either payload (exit 1). Only text that
    # does not parse is the usage refusal (exit 2).
    decoder = json.JSONDecoder()
    lines: list[str] = []
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
        lines.append(json.dumps({"box": args[1], "request": request}, separators=(",", ":"), ensure_ascii=False))
    return "\n".join(lines)


def cmd_execution(cfg: Config, args: list[str]) -> int:
    action = args[0] if args else ""
    payload = "{}"
    match action:
        case "list":
            active = compact_view = False
            for arg in args[1:]:
                if arg == "--active":
                    active = True
                elif arg == "--compact":
                    compact_view = True
                else:
                    die(LIST_USAGE)
            payload = json.dumps({"active": active, "compact": compact_view}, separators=(",", ":"))
        case "slot":
            from ludics.fleetworker import slot

            return slot.cmd_slot(cfg, args[1:])
        case "hold":
            from ludics.fleetworker import slot

            return slot.cmd_hold(cfg, args[1:])
        case "conclude":
            mode = args[1] if len(args) > 1 else ""
            if mode == "--from-run":
                payload = from_run_payload(cfg, args)
            elif mode == "--from-bg-run":
                payload = from_bg_run_payload(cfg, args)
            else:
                payload = conclude_payload(cfg, args)
        case "reserve" | "run" | "dispatch" | "record" | "reconcile":
            payload = read_payload(action, args)
            check_identity(cfg)
            if action in ("record", "reconcile"):
                payload = checked_evidence(cfg, payload, "")
            else:
                checked_request(payload, action)
        case "window":
            # THE MEASUREMENT WINDOW (ludics-lite#481): the box is named apart from the payload so
            # the call says which box's standing reservations it suspends, and the registry refuses
            # a payload measuring on any other.
            payload = window_payload(args)
            check_identity(cfg)
            checked_request(payload, action)
        case _:
            die(USAGE)
    source = registry_source()
    map_spec = ""
    if action in ("reserve", "run", "dispatch", "window"):
        found = endpoint_map(cfg)
        if found is None:
            return 1
        map_spec = found
    token = my_token(cfg)
    script = (
        prelude(cfg, cfg.anchor)
        + (LEASE_MUTATION if action != "list" else "shift 3\n")
        + registry_command(source)
    )
    argv = [
        "EXECUTION", token, cfg.lock_wait, action, coordinator_id(cfg), token, payload,
        cfg.boxes, cfg.slots, map_spec, fleet_name(cfg, cfg.anchor), fleet_name(cfg, cfg.lab_host),
    ]  # fmt: skip
    done = run_on(cfg, cfg.anchor, script, argv, capture=True)
    out = substitution(done.out)
    cli.emit(out)
    if done.unreachable:
        cli.say(f"EXECUTION UNREACHABLE {cfg.anchor}: outcome unknown; reconcile before retrying dispatch")
        return 4
    if done.rc == 0 and action in ("run", "dispatch", "window"):
        execution_refresh(cfg, out)
    return done.rc

