"""``board takeover <wave> <task>`` (ludics-lite#731): a worker's takeover brief, from the board.

On 2026-10-19 a coordinator restart killed every in-process worker, and their briefs were rebuilt
by hand from scratch files. The durable brief already existed; what was missing was the state a
replacement needs beside it. So the coordinator keeps THE TAKEOVER KEYS on the worker's board row
(below; native-workers.md says when it writes them), and this verb prints the stored brief followed
by a generated ``## State at takeover`` section: the keys, then what the live sources say now.

THE TAKEOVER KEYS, each a ``board set`` value, read fail-closed by the grammar named here; a value
outside it prints ``invalid: <value> (<why>)`` and is not used, a key the row lacks prints
``missing`` and is never guessed:

  worktree    the worker's checkout, absolute (or ``~/``) on its agent host
  branch      its branch                                   base     the base SHA it started from
  agent       the runtime's agent identity                 transport how the worker runs
  agent_host  the box the worker's checkout and runs are on (a box name)
  exec_hosts  where its executions run (free text)
  brief       the stored brief, absolute (or ``~/``) on brief_host
  brief_host  the box the brief is on (a box name); missing, the brief is read on this box, saying so
  repository  ``owner/name``                               issue    ``owner/name#N``
  worker      the registry's ``request.worker`` for this worker
  pr          the PR number, once there is one
  runs        the bg-run parent of the worker's runs, absolute (or ``~/``) on agent_host
  standing    request ids, space-separated, or ``none``    requests the same, for its other requests
  farside     far-side worktrees, ``<box>:<path>`` words (printed, not read)
  plan_dir    a paired plan's directory (printed, not read)

What it reads, and nothing else (the boundary): the board (``board show --json`` on the anchor, no
lock, no lease); the brief, a file on brief_host; on agent_host, the worktree's HEAD, branch and
uncommitted-path count (``git --no-optional-locks``, so no index refresh is written under a live
worker; a status that fails reads unreadable, never clean), and ``bg-run.sh wait <dir> --within 0`` for each ``run-<N>`` under ``runs``
(the box's own skills checkout's bg-run.sh); GitHub, ``gh pr view`` of ``pr``, or with no ``pr`` a
``gh pr list --head <branch>`` printed as a lookup by branch, never as the row's; and the execution
registry's records for this wave and ``worker``, every state but ``concluded``, beside the ids the row
names. A live reading that disagrees with the row (another branch) is printed as a conflict; it never
replaces the row's value. An unreadable source prints why, and the rest still prints.

What it is not: it writes nothing, takes no lease, launches, stops and reconciles nothing, and it
does not establish that the old worker's processes are gone -- the coordinator still resolves each
checkout's writer before a replacement starts (native-workers.md, *Supervision, recovery and
evidence*).

Exit: 0 printed; 3 printed, but the brief could not be read (so this is no takeover brief: a caller
that hands it to a spawn must not proceed); 1 no board or no such task; 2 usage; 4 the anchor did
not answer. The section's lines are for a reader, never a grammar.
"""

import json
import re
import shlex
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, cast

from ludics import cli, proc
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import PAYLOAD_ON_FD, err, fleet_name, prelude, run_on

USAGE = "board takeover <wave> <task>"

PATH = re.compile(r"(/|~/|[A-Za-z]:[/\\]).*", re.S)
BOX = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
ISSUE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*")
REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
BRANCH = re.compile(r"[^\s~^:?*\[\\]+")
SHA = re.compile(r"[0-9a-f]{7,64}")
PR = re.compile(r"[1-9][0-9]*")


def _ids(value: str) -> str | None:
    words = value.split()
    if words == ["none"]:
        return None
    if not words:
        return "empty (write none for no requests)"
    bad = [w for w in words if not REQUEST_ID.fullmatch(w)]
    return f"not a request id: {' '.join(bad)}" if bad else None


def _by(pattern: re.Pattern[str], what: str) -> Callable[[str], str | None]:
    return lambda value: None if pattern.fullmatch(value) else f"not {what}"


def _free(value: str) -> str | None:
    return None if value.strip() else "empty"


# THE TAKEOVER KEYS, in the order printed, each with its grammar (None: within it; else why not).
KEYS: list[tuple[str, Callable[[str], str | None]]] = [
    ("worktree", _by(PATH, "an absolute path")),
    ("branch", _by(BRANCH, "one branch name")),
    ("base", _by(SHA, "a commit SHA")),
    ("agent", _free),
    ("transport", _free),
    ("agent_host", _by(BOX, "a box name")),
    ("exec_hosts", _free),
    ("brief", _by(PATH, "an absolute path")),
    ("brief_host", _by(BOX, "a box name")),
    ("repository", _by(REPOSITORY, "owner/name")),
    ("issue", _by(ISSUE, "owner/name#N")),
    ("worker", _by(REQUEST_ID, "a worker name")),
    ("pr", _by(PR, "a PR number")),
    ("runs", _by(PATH, "an absolute path")),
    ("standing", _ids),
    ("requests", _ids),
    ("farside", _free),
    ("plan_dir", _free),
]

# Far side, on brief_host: the brief's text, or exit 3 with why on stdout.
READ_BRIEF = r"""
f=$(expand_tilde "$1")
if [ -f "$f" ] && [ -r "$f" ]; then cat -- "$f"; else printf '%s\n' "no readable file $f on $BOX"; exit 3; fi
"""

# Far side, on agent_host: the worktree's facts, one key=value line each.
WORKTREE = r"""
wt=$(expand_tilde "$1")
[ -d "$wt" ] || { printf 'gone=%s\n' "$wt"; exit 0; }
head=$(git -C "$wt" rev-parse --verify -q HEAD 2>/dev/null) || { printf 'nogit=%s\n' "$wt"; exit 0; }
branch=$(git -C "$wt" symbolic-ref -q --short HEAD 2>/dev/null) || branch=
# Read-only: no optional lock (no index refresh written under a live worker), and a status that
# fails is unreadable, never clean.
if left=$(git --no-optional-locks -C "$wt" status --porcelain 2>/dev/null); then
  if [ -z "$left" ]; then dirty=0; else dirty=$(printf '%s\n' "$left" | grep -c ''); fi
else
  dirty=unreadable
fi
printf 'head=%s\nbranch=%s\ndirty=%s\n' "$head" "$branch" "$dirty"
"""

# Far side, on agent_host: each run under the parent, tab, bg-run's verdict line.
RUNS = r"""
d=$(expand_tilde "$1")
[ -d "$d" ] || { printf 'none\t%s\n' "$d"; exit 0; }
bg="$(expand_tilde "$SKILLS_REPO")/issue-wave/scripts/bg-run.sh"
[ -r "$bg" ] || { printf 'nobg\t%s\n' "$bg"; exit 0; }
for r in "$d"/run-*; do
  [ -d "$r" ] || continue
  v=$(BG_RUN_HEARTBEAT=0 bash "$bg" wait "$r" --within 0 2>/dev/null | head -n 1)
  printf '%s\t%s\n' "$r" "${v:-unreadable}"
done
"""


def board_document(cfg: Config, wave: str) -> dict[str, Any] | int:
    """The wave's board, as ``board show --json`` reads it, or the exit status to end with."""
    from ludics.fleetworker.board import store_command

    raw = json.dumps({"wave": wave, "json": True}, separators=(",", ":"))
    script = prelude(cfg, cfg.anchor) + "shift 3\n" + store_command(raw)
    done = run_on(cfg, cfg.anchor, script, ["BOARD", "x", "x", "show", "x", PAYLOAD_ON_FD], capture=True)
    if done.unreachable:
        cli.say(f"BOARD UNREACHABLE {cfg.anchor}")
        return 4
    if done.rc != 0:
        return 1  # the store said why on stderr
    try:
        doc: Any = json.loads(done.out)
    except ValueError:
        err(f"BOARD REFUSED: the board of {wave} is not JSON")
        return 1
    if not isinstance(doc, dict):
        err(f"BOARD REFUSED: the board of {wave} is not an object")
        return 1
    return cast(dict[str, Any], doc)


def row_of(doc: dict[str, Any], task: str) -> dict[str, Any] | None:
    tasks: Any = doc.get("tasks")
    for row in cast(list[Any], tasks) if isinstance(tasks, list) else []:
        if isinstance(row, dict) and cast(dict[str, Any], row).get("task") == task:
            return cast(dict[str, Any], row)
    return None


def checked(fields: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """The row's takeover keys within their grammar, and one line per documented key."""
    good: dict[str, str] = {}
    lines: list[str] = []
    for key, grammar in KEYS:
        if key not in fields:
            lines.append(f"- {key}: missing")
            continue
        value = fields[key]
        why = grammar(value)
        if why is None:
            good[key] = value
            lines.append(f"- {key}: {value}")
        else:
            lines.append(f"- {key}: invalid: {value} ({why})")
    known = {key for key, _ in KEYS}
    for key, value in fields.items():
        if key not in known:
            lines.append(f"- {key} (another key of the row): {value}")
    return good, lines


def brief_text(cfg: Config, keys: dict[str, str], fields: dict[str, str]) -> tuple[str | None, str]:
    """The stored brief, or None and why it could not be read; and the line saying where it was read."""
    if "brief" not in keys:
        return None, "the row has no valid brief key" if "brief" in fields else "the row names no brief"
    if "brief_host" in fields and "brief_host" not in keys:
        # Never another box's file by default: an invalid host is no host to read on.
        return None, f"the row's brief_host is invalid, so {keys['brief']} is read nowhere"
    host = keys.get("brief_host") or fleet_name(cfg, "local")
    where = f"on {host}" if "brief_host" in keys else "on this box (the row names no brief_host)"
    done = run_on(cfg, host, prelude(cfg, host) + READ_BRIEF, [keys["brief"]], capture=True)
    if done.unreachable:
        return None, f"{host} did not answer for the brief {keys['brief']}"
    if done.rc != 0:
        return None, done.out.strip() or f"exit {done.rc} reading {keys['brief']} {where}"
    return done.out, f"{keys['brief']} {where}"


def worktree_lines(cfg: Config, keys: dict[str, str]) -> list[str]:
    if "worktree" not in keys or "agent_host" not in keys:
        return ["- not read: the row lacks a valid worktree or agent_host"]
    host, wt = keys["agent_host"], keys["worktree"]
    done = run_on(cfg, host, prelude(cfg, host) + WORKTREE, [wt], capture=True)
    if done.unreachable:
        return [f"- {host} did not answer"]
    facts = dict(line.split("=", 1) for line in done.out.splitlines() if "=" in line)
    if done.rc != 0 or not facts:
        return [f"- unreadable on {host} (exit {done.rc}): {done.out.strip()[:200]}"]
    if "gone" in facts:
        return [f"- {wt} is gone on {host}"]
    if "nogit" in facts:
        return [f"- {wt} on {host} is no git checkout"]
    branch = facts.get("branch", "") or "(detached HEAD)"
    dirty = facts.get("dirty", "unreadable")
    count = "uncommitted paths unreadable (git status failed)" if dirty == "unreadable" else f"{dirty} uncommitted path(s)"
    lines = [f"- on {host}: HEAD {facts.get('head', '?')}, branch {branch}, {count}"]
    if "branch" in keys and facts.get("branch", "") != keys["branch"]:
        lines.append(f"- CONFLICT: the row says branch {keys['branch']}, the worktree is on {branch}")
    return lines


def gh_json(cfg: Config, args: list[str]) -> Any | str:
    """A gh call's JSON, or why there is none."""
    from ludics.fleetworker.execution import gh_timeout

    done = proc.run_tool("gh", args, timeout=gh_timeout(cfg))
    if done.rc != 0:
        return f"gh {shlex.join(args[:3])} exit {done.rc}: {done.stderr.strip()[:200]}"
    try:
        return json.loads(done.stdout)
    except ValueError:
        return f"gh {shlex.join(args[:3])} answered no JSON"


PR_FIELDS = "number,state,isDraft,headRefName,headRefOid,mergeCommit,reviewDecision,url"


def pr_line(pr: dict[str, Any]) -> str:
    merged: Any = pr.get("mergeCommit")
    oid = cast(dict[str, Any], merged).get("oid") if isinstance(merged, dict) else None
    merge = f", merge commit {oid}" if oid else ""
    draft = " (draft)" if pr.get("isDraft") else ""
    review = f", review {pr.get('reviewDecision')}" if pr.get("reviewDecision") else ""
    return (f"#{pr.get('number')} {pr.get('state')}{draft}, head {pr.get('headRefName')} at {pr.get('headRefOid')}"
            f"{merge}{review}, {pr.get('url')}")


def pr_lines(cfg: Config, keys: dict[str, str]) -> list[str]:
    if "repository" not in keys:
        return ["- not read: the row lacks a valid repository"]
    repo = keys["repository"]
    if "pr" in keys:
        got = gh_json(cfg, ["pr", "view", keys["pr"], "--repo", repo, "--json", PR_FIELDS])
        if isinstance(got, str):
            return [f"- unread: {got}"]
        pr = cast(dict[str, Any], got) if isinstance(got, dict) else {}
        lines = [f"- {pr_line(pr)}"]
        if "branch" in keys and pr.get("headRefName") != keys["branch"]:
            lines.append(f"- CONFLICT: the row says branch {keys['branch']}, PR #{keys['pr']}'s head is {pr.get('headRefName')}")
        return lines
    if "branch" not in keys:
        return ["- pr: missing, and no valid branch to look one up by"]
    got = gh_json(cfg, ["pr", "list", "--repo", repo, "--head", keys["branch"], "--state", "all", "--json", PR_FIELDS])
    if isinstance(got, str):
        return [f"- pr: missing; the lookup by branch was unread: {got}"]
    found = [cast(dict[str, Any], p) for p in cast(list[Any], got) if isinstance(p, dict)] if isinstance(got, list) else []
    if not found:
        return [f"- pr: missing; GitHub lists no PR with head {keys['branch']} in {repo}"]
    return [f"- pr: missing; a lookup by head {keys['branch']} lists:"] + [f"  - {pr_line(p)}" for p in found]


def request_lines(cfg: Config, wave: str, keys: dict[str, str]) -> list[str]:
    from ludics.fleetworker.execution import listing, records_of

    named: list[str] = []
    for key in ("standing", "requests"):
        if key in keys and keys[key] != "none":
            named += [w for w in keys[key].split() if w not in named]
    done = listing(cfg)
    if done.unreachable:
        return [f"- the registry on {cfg.anchor} did not answer; the row names: {' '.join(named) or 'none'}"]
    records = records_of(done.out) if done.rc == 0 else None
    if records is None:
        return [f"- the registry could not be read; the row names: {' '.join(named) or 'none'}"]
    by_id = {r.get("request_id"): r for r in records}
    worker = keys.get("worker")
    mine = [r for r in records if r.get("state") != "concluded" and isinstance(r.get("request"), dict)
            and cast(dict[str, Any], r["request"]).get("wave") == wave
            and worker is not None and cast(dict[str, Any], r["request"]).get("worker") == worker]
    lines: list[str] = []
    if worker is None:
        lines.append("- not looked up by worker: the row lacks a valid worker key")
    seen: set[str] = set()
    for record in mine:
        rid = cast(str, record.get("request_id"))
        seen.add(rid)
        source = "named on the row" if rid in named else "NOT named on the row"
        lines.append(f"- {rid}: {describe(record)}; outstanding for worker {worker}, {source}")
    for rid in named:
        if rid in seen:
            continue
        record = by_id.get(rid)
        if record is None:
            lines.append(f"- {rid}: named on the row, not in the registry")
        else:
            req: Any = record.get("request")
            owner = cast(dict[str, Any], req) if isinstance(req, dict) else {}
            lines.append(f"- {rid}: {describe(record)}; named on the row"
                         + ("" if record.get("state") == "concluded"
                            else f" (its request names wave {owner.get('wave')}, worker {owner.get('worker')})"))
    return lines or ["- none outstanding for this worker, and the row names none"]


def describe(record: dict[str, Any]) -> str:
    request: Any = record.get("request")
    req = cast(dict[str, Any], request) if isinstance(request, dict) else {}
    state = record.get("state")
    if state == "concluded":
        state = f"concluded {record.get('verdict')}"
    elif state == "suspended":
        state = f"suspended by {record.get('suspended_by')}"
    parts = [str(state), str(req.get("kind"))]
    if req.get("standing") is True:
        parts.append("standing")
    parts.append(f"on {req.get('execution_host')}")
    if isinstance(record.get("checkout"), str):
        parts.append(f"checkout {record['checkout']}")
    return ", ".join(parts)


def run_lines(cfg: Config, keys: dict[str, str]) -> list[str]:
    if "runs" not in keys or "agent_host" not in keys:
        return ["- not read: the row lacks a valid runs or agent_host"]
    host = keys["agent_host"]
    done = run_on(cfg, host, prelude(cfg, host) + RUNS, [keys["runs"]], capture=True)
    if done.unreachable:
        return [f"- {host} did not answer"]
    rows = [line.split("\t", 1) for line in done.out.splitlines() if "\t" in line]
    if done.rc != 0:
        return [f"- unreadable on {host} (exit {done.rc})"]
    if rows and rows[0][0] == "none":
        return [f"- no directory {rows[0][1]} on {host}"]
    if rows and rows[0][0] == "nobg":
        return [f"- not read: no {rows[0][1]} on {host}"]
    if not rows:
        return [f"- no run-<N> under {keys['runs']} on {host}"]

    def number(row: list[str]) -> int:
        tail = row[0].rsplit("run-", 1)[-1]
        return int(tail) if tail.isdecimal() else -1

    return [f"- {path}: {verdict}" for path, verdict in sorted(rows, key=number)]


def cmd_takeover(cfg: Config, args: list[str]) -> int:
    if len(args) != 2 or not all(args):
        die(f"board takeover: expected <wave> <task> ({USAGE})")
    wave, task = args
    doc = board_document(cfg, wave)
    if isinstance(doc, int):
        return doc
    row = row_of(doc, task)
    if row is None:
        err(f"BOARD REFUSED: no task {json.dumps(task, ensure_ascii=False)} on the board of {wave}")
        return 1
    raw: Any = row.get("fields")
    fields = {str(k): str(v) for k, v in cast(dict[Any, Any], raw).items()} if isinstance(raw, dict) else {}
    keys, key_lines = checked(fields)
    brief, where = brief_text(cfg, keys, fields)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out: list[str] = []
    if brief is not None:
        out.append(brief.rstrip("\n"))
        out.append("")
    out += [
        "## State at takeover",
        "",
        f"Generated {now} by `fleet-worker.sh board takeover {wave} {task}` from the board row (updated"
        f" {row.get('updated_at')}), the execution registry on {cfg.anchor}, GitHub and the worker's agent host."
        " A key the row lacks is printed as missing, never inferred; a live reading never replaces the row's value.",
        "",
        f"- brief: {where}" if brief is not None else f"- BRIEF UNREADABLE: {where} (this is no takeover brief)",
        "",
        "### Board keys",
        *key_lines,
        "",
        f"### Worktree ({keys.get('worktree', 'missing')})",
        *worktree_lines(cfg, keys),
        "",
        "### Pull request",
        *pr_lines(cfg, keys),
        "",
        "### Execution requests",
        *request_lines(cfg, wave, keys),
        "",
        f"### bg-run runs ({keys.get('runs', 'missing')})",
        *run_lines(cfg, keys),
        "",
        "Before a replacement starts: establish that the old worker's processes cannot write to the"
        " worktree (native-workers.md, *Supervision, recovery and evidence*).",
    ]
    cli.say("\n".join(out))
    return 0 if brief is not None else 3
