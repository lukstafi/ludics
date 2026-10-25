"""Anchor-side execution records. Invoked by fleet-worker under its coordinator lock.

This records cooperative ownership; it neither launches nor supervises processes.

How it runs (ludics-lite#403). This module is SHIPPED: fleet-worker.sh's `execution` sends its
source to the anchor, where a Python >= 3.12 runs it from stdin (`python - <argv>`), under the
anchor's lease lock. So it is self-contained -- the standard library only, nothing imported from
the `ludics` package, which the anchor's own checkout may hold at another version -- and its argv
is the contract below. It is also what the registry suite loads in process with `runpy` (patching
`os.replace` between records, so every published record is exactly one `os.replace`), and what the
package's unit tests import; `main` runs when the module is run as a program, as stdin, or by
`runpy.run_path`, and not on import.

Argv: <state root> <action> <coordinator> <lease token> <json payload> <FLEET_BOXES>
      [<FLEET_BOX_CORRECTNESS_SLOTS> [<endpoint map> [<anchor> <lab host>]]]

The payload (ludics-lite#636): the word `-` says it is on file descriptor 3, where fleet-worker puts
it -- one line, the payload as a JSON string, read to its end and closed (`payload_word`); any other
word is the payload itself (a direct `python registry.py` call, the in-process suites). So argv
carries only the small words above, and no length of payload, which is the caller's to choose (a
hand-written `evidence`), can fail execve: one argv word is capped at 128 KiB on Linux, for the
local `bash -s` and ssh's remote command alike. The far-side framing is fleet-worker's
`transport.shipped_python`; this module reads only what its contract says, nothing else on fd 3.

Ownership per execution host (ludics-lite#157): a `measurement` assignment is exclusive -- it
refuses while anything else is outstanding on the box, and everything refuses while it is. A
`correctness` assignment shares the box with other correctness assignments up to that box's
slot count (`<box>=<n>` pairs in the slots spec; one slot for any box the spec does not name).

A correctness request may carry `"standing": true` (ludics-lite#160): a standing iteration
record is the ownership/evidence record of a worker's whole life, taken at launch and concluded
at hand-back, so it consumes no slot -- the slots are taken at run time by
`fleet-worker.sh execution slot`, around each batch. It is still outstanding for every other
purpose, so a measurement keeps the box to itself.

One roster entry per physical box (ludics-lite#395). Ownership is keyed by the exact
FLEET_BOXES entry, so a roster naming two aliases of one box (`rog-nv-linux` and `rog-nv-wsl`)
would admit a measurement on one beside a run on the other, and the exclusivity above -- which
`wake-lab.sh boot-windows --as=<request_id>` relies on -- would split silently. So reserve, run and
dispatch refuse such a roster, naming both entries and the box they share; reads and
evidence/conclusion stay available, as for a noncanonical outstanding host. What is one box is read
from the endpoint map argument, `wake-lab.sh endpoint-map` as fleet-worker passes it: one line per
box, the box name and then its ssh aliases. The boundary, fail-closed within it: two roster
entries are one box when the map puts both on one row (the box name counts as one of its row's
aliases), or when they differ only by case, as ssh lowercases a host name before matching its
config; a map naming one alias on two rows is refused whole. It deliberately does not read
~/.ssh/config: two `Host` stanzas pointing at one HostName outside the map are not detected. An
empty or absent map argument keeps today's behaviour (each entry is its own box, up to case);
fleet-worker passes one only when its checkout has no wake-lab.sh, and says so on stderr.
`list --host <box>` (ludics-lite#557) selects one box's records by this same rule, so an alias
(`rog`) selects its roster entry's (`rog-nv-linux`), and a name that is no roster entry's box is
refused.

A coordinator's correctness request may carry `"integration": true` (ludics-lite#401): the run is
the repository's full integration suite at a merged tip, and once concluded pass or fail at an
exact `observed_sha` it is the verdict source `fleet-worker.sh gate` offers `pr-review.sh base`
for a default branch without push CI. The field is what tells it from a targeted batch, which is
a correctness run too; the gate reads no record without it.

A measurement refuses a box a sweep lane holds (ludics-lite#445). OCANNL's daily sweep owns no
record here; what says a lane is running on a lab box is that box's LANE lock, the flock
`<lock dir>/<box>.lock` it takes for the length of the lane (`wake-lab.sh`'s lab lock lore). So a
`measurement` reserve, run or dispatch takes that lock SHARED and non-blocking, refuses naming the
holder's first line (e.g. `ocannl sweep <stamp> (pid ..., since ...)`) when it is held, and keeps
it until this process exits, after the record is written. The lane takes it EXCLUSIVE and reads
this registry before each unit only once it holds it, and every destroyer in wake-lab.sh takes it
EXCLUSIVE before it reads this registry too, so neither can slip between this check and the record
it guards. What it reads, and nothing else: the box is the endpoint map row naming the execution
host (the map argument above; a host on no row, or no map at all, is not a lab box and has no lane
lock), and the lock directory is THIS process's -- WAKE_LAB_LOCK_DIR, else
~/.local/state/wake-lab, the default wake-lab.sh and the sweep share. That directory is the lab's
only on the machine that runs wake-lab.sh and the sweep; anywhere else it holds no lane's lock and
every measurement would pass. So before reading it, a measurement on a lab box verifies that this
anchor is that machine, and refuses naming both when it is not (ludics-lite#454). Two facts, and
nothing else: the anchor's fleet name and the lab host's (the last two arguments, FLEET_ANCHOR and
FLEET_LAB_HOST as fleet-worker resolves them) are one name up to case, which catches an anchor
moved without the lab or a lab moved and declared; and the wake-lab site file -- WAKE_LAB_HOSTS,
else ~/.config/wake-lab/hosts.sh, what wake-lab.sh refuses to drive the lab without -- is a
readable file here, which catches a declaration naming a machine that cannot drive the lab. It
resolves no alias, reads none of the file's contents, and cannot see a sweep moved to another
box that has a site file of its own but was never declared: the declaration is that fact's only
source. Absent identity arguments refuse. WAKE_LAB_LOCK_DIR and WAKE_LAB_HOSTS are read from THIS
process's environment -- the anchor's, as its own wake-lab.sh and sweep would see them -- and never
forwarded from the coordinator's: a coordinator's path names a file on the coordinator's machine. A
custom path is set where the anchor's non-interactive ssh shell reads it. The box's HOLD
lock is not read: a hold keeps a VM alive and says nothing about who works there. A lock file that
cannot be created or opened is free, as wake-lab.sh treats it (no lane can hold what it cannot open:
the sweep fails such a lane rather than running it); one that opens but cannot be probed refuses.
Correctness reservations never read the lock.

The measurement window (ludics-lite#481). Every native worker holds a standing correctness record on
its agent host for its whole life, and a measurement is refused while anything is outstanding on its
box, so a measurement on a wave's agent host was never admitted until the coordinator concluded every
standing record there `cancelled` (a conclusion describing no run), measured, and took fresh ones
under invented ids. `window` (payload `{"box": <box>, "request": <measurement reserve.json>}`) does
it under this one lock: it refuses unless everything outstanding on the box is standing, writes the
measurement as `run` does (reserved and dispatched, `"window": true` on the record), then moves each
standing record there to state `suspended`, naming the measurement in `suspended_by` and its former
state in `suspended_from`. Concluding that measurement, whatever the verdict, first restores every
record it suspended to its former state and then writes the conclusion, so no record is ever left
suspended by a concluded measurement. A standing reservation taken while a window is open is admitted
straight into `suspended` by it (queued, not refused: the worker's launch does not wait for the
window). A suspended record takes no dispatch, record or reconcile -- the window owns its state --
but may be concluded, which is how a worker handing back mid-window ends it. A retried `window` with
the same request never dispatches twice: it suspends any standing record not yet suspended and prints
the record. There is one measurement per window, so the registry still never holds two outstanding
measurements on a box (`execution slot`'s in-hold admission, ludics-lite#480, relies on that).

The gap between windows (ludics-lite#667). A coordinator running a box's measurements back to back
concluded one window and opened the next seconds later, so a batch waiting out the first (`execution
slot --wait-window`, which re-reads this registry every 15 s) read the second and never the gap
between them, and was refused at its bound: a merge build four times, 30 minutes each. So a NEW
window's payload may carry `"gap": <seconds>` (a whole number; absent or 0 is none), and when a
measurement on its box concluded less than that long ago (its record's `updated_at`, this anchor's
clock) while a batch is waiting for the box (THE WAITERS, below), the window is not written: `run`
exits 3 with `{"gap": {"box", "after", "ago", "gap", "wait", "waiting"}}` on stdout and an
`EXECUTION WINDOW` line on stderr naming the measurement it follows and the seconds still to go (`wait`, at most
`gap`). The gap is the last of a new window's admission checks, so a window anything else refuses
(a halt, a lane lock, an open window) is refused at once. The near side (`execution window`) waits
those seconds with no lock held and asks again with the gap less what it has waited, so its whole
wait is the gap at most, a conclusion stamped ahead of this clock included, and a handover stays
two calls, the second taking up to the gap. A conclusion is stamped when it is published, after the
records it restores, so the gap is measured from the moment a reader sees the box free. The answer's
`waiting` names the waiters it is kept for. A retried window (its record exists) never waits.

THE WAITERS (ludics-lite#719). The gap first read standing records as "workers there may be
waiting", so it was paid whether or not anyone waited. A batch waiting out a measurement (`execution
slot --wait-window` on the box, `execution leg --wait-window` on its agent host) reads this registry
with `wait` instead of `list`, from the read that first finds the box held on (so no window can
come and go unseen between that read and the first heartbeat): payload `{"waiter": {"box", "id",
"command", "ttl"}}` plus `list`'s own options, lease-free like `list`, answered with the listing
`list` gives. A leg, which learns its box from that same read, names its record instead of a box
(`"request": <id>` in place of `"box"`): the waiter waits for that record's execution host, and an
unknown request records nothing. Before answering it writes
`waiters/<id>.json` under the state root -- `{box, id, command, seen, expires}`, `expires` being
`ttl` seconds (1 to 3600) from this anchor's clock -- and removes every other waiter file already
expired, then reads the executions it answers with. All of that is under the flock `waiters/.lock`,
which a window with a gap also takes before it reads the waiters and holds until it is published: so
a removal never deletes a renewal, and a heartbeat and a window cannot pass each other -- either the
window sees the heartbeat, or the listing sees the window. It writes nothing under `executions/`: a waiter owns nothing, and no lease is needed to say
one is waiting. A waiter's ttl outlasts its poll (the near side sends three polls' worth), so its
last heartbeat, the one that read the box free, stays fresh while it takes its slot. A new window's
gap is kept when a waiter on its box (the one-box rule above) has not expired. Fail-closed toward
the gap: a waiter file that does not parse counts as a waiter on every box. A waiter that no longer
needs the gap -- it holds its slot, it was refused, or it found nothing to wait for -- sends `wait`
with `{"waiter": {"id", "done": true}}`, which removes its file (best effort: one that is not sent
expires). The boundary: a waiter
the gap sees is a batch that read this registry while waiting; a batch queued for a free SLOT reads
no registry (the box-local `waiting.<pid>` record is its trace, which `slot --holders` lists, and a
window's drain takes slots as they free), and a box whose fleet-worker predates #719 waits with
`list`, unseen, so its batches get no gap.

THE WINDOW'S DEADLINE (ludics-lite#737). A window's payload may carry `"deadline": <seconds>` (a
whole number from 1 to a week) beside `box`, `request` and `gap`, never in the request: the time from the
window's opening by which its coordinator will have CONCLUDED it -- its runner's `--deadline`, the
setup before it, and the conclusion's own latency. The record keeps `deadline` and `deadline_at`
(ISO 8601 UTC on this anchor's clock: when this action created the window, after any gap, plus
`deadline`, which the ledger's validation holds it to), fixed for the record's life: a retried window names the same deadline, or none when the
record has none, or is refused, and never moves `deadline_at`. Only `window` takes one. A listing
(`list`, `wait`) adds `deadline_left` to such a record: the whole seconds from this anchor's clock
to `deadline_at`, 0 once past, so a waiter on another host reads the time left without comparing
its clock with this one (the field is the listing's, never written). It bounds
the waiters and nothing else: `execution slot --wait-window` with no value (and `execution leg`'s)
gives up at it, an hour where no measurement holding the box records one; it does not end the
measurement, conclude its record, or release anything.

THE SNAPSHOT (ludics-lite#711). A window's opening publishes the measurement and then suspends the
box's standing records, and its conclusion restores them and then concludes it: several files, one
`os.replace` each (the order above covers a crash). A reader between two of them, or one whose own
read of the files a write overtook, saw the window open beside records not suspended, or concluded
beside records still suspended. So every action takes the flock `executions.lock` under the state
root -- `list` and `wait` SHARED, every other action EXCLUSIVE -- from before it reads the records
until `run` returns; a listing is then the ledger between two whole actions. What it covers, and
nothing else: writers and readers that ship this module with the lock. A copy that predates it (a
caller whose checkout lags) writes unlocked, so a torn read stays possible until every caller's
checkout carries it, and `execution leg`'s re-read tolerance stays. The lock order, fail-closed: the
lease lock (fleet-worker's mkdir lock, taken by the shell before this program starts), then
`executions.lock`, then `waiters/.lock`, then a lane lock (never waited for); `wait` takes the
snapshot before its heartbeat's `waiters/.lock`, as a window with a gap does, so the two never
cross. Nothing an action says is written while it holds either (`run` buffers it, and releases both
first), so a caller that stops reading stalls only its own action; a lane lock is still held to
the process's exit, as above. The wait for it is bounded (`LOCK_WAIT`, polled): past it the action is refused, the
registry busy, rather than a reader hanging behind a wedged writer. The anchor is POSIX: this
module already flocks, and no anchor runs under Git Bash.

A request that follows a branch (ludics-lite#558): `"requested_revision": "head-of:<branch>"` names
no commit at request time, so a request queued behind a halt or a busy box cannot go stale (three
SHA-keyed requests of the 2026-10-05 wave did, one twice). The branch is resolved when the work is
ASSIGNED: the dispatch step (`run`, `window`, `dispatch`) must carry `resolved_revision`, the exact
commit the near side read off GitHub a moment before, and the record keeps it as a top-level field
(and in that dispatch's history entry) through to its conclusion. The grammar, fail-closed: the
whole revision is `head-of:` and one branch name of `[A-Za-z0-9._/-]`, not starting with `-`, with
no `..`, and every `/`-separated component nonempty, not starting with `.` and not ending in `.` or
`.lock` (git-check-ref-format's rules within that alphabet); anything else starting `head-of:` is
refused at reserve. Any other revision is the free text it always was, and a dispatch
carrying `resolved_revision` for one is refused, as is a head-of dispatch without it. A reconcile to
`reserved` and a later dispatch resolve again: each dispatch records the commit it assigned. A
head-of record never dispatched names no commit, so reconcile refuses to make it `running` or
`uncertain`; and once resolved, an `observed_sha` that any later payload names must be that commit.

THE BINDING (ludics-lite#634): the one commit a record's evidence may name, `bound_commit`. Fail-closed
on what binds, and nothing else: a record's `resolved_revision` (above), else -- for a request
WITHOUT `"standing": true` -- a `requested_revision` that is, whole, one exact object ID (40 or 64
lowercase hex, as `observed_sha` is spelled). Every other revision is free text (`<sha> plus working
diff`, a ref, prose, a SHA with surrounding blanks) and binds nothing; a standing record covers a
worker's whole life, each batch at the commit it then has, and binds only through a resolution.
For a bound record, a `dispatch`, `record`, `reconcile` or `conclude` whose `observed_sha` is
another commit is refused naming the bound one; so is a conclusion naming none (other than
`not-launched`) when the observed_sha it would inherit is another commit (one recorded before this
check). The escape for a deliberate re-pin is a new request id, which the refusal states. A
concluded record answers its identical retry before this check, so a record concluded before it
existed keeps its retries. `execution leg` reads the same function, so it refuses to run what the
registry would refuse to record.

THE CHECKOUT (ludics-lite#731): the one checkout a record's `--observed-from` conclusion may read,
`checkout`, an absolute path on the execution host (POSIX, or a drive letter). A reserve, run or
window payload may carry it BESIDE the request -- removed from the request, as `run` removes
`evidence` -- and the record keeps it as a top-level field, fixed for the record's life (in its
reserve history event too). It is never a request field: every caller ships its own copy of this
module and validates the whole ledger with it, and an older copy refuses a request field it does
not know, which would refuse every record to every box whose checkout lags, while it ignores a
top-level field. A NEW standing request must carry it (a standing record is concluded at its
worker's hand-back with `--observed-from`, and on 2026-10-18 one was concluded off another worker's
worktree); any other request may. A retried reserve or run names the same checkout, or none if the
record has none, or is refused. `remote_checkout` is not it: that is the evidence's own field, which
any record, reconcile or conclude payload rewrites. What reads it is fleet-worker's near side
(`execution.observed_sha_of`, and `execution leg`, whose `--worktree` must be it: ludics-lite#749);
this module only records it.

A request's `issue` is optional (ludics-lite#664): the one issue the work is for, spelled exactly
`owner/name#N` -- `fleet-worker.sh prs --wave` reads it as one -- or absent, for work with no issue of
its own (a post-wave task, an integration run), whose label goes in `purpose`. A placeholder that
names no issue (`owner/name#post-1`, `<repo> integration`) is refused when a request is NEW (reserve,
run, window). The ledger keeps the free-text spellings recorded before, and a retry of such a request
still answers with its record: what a record holds is validated only as a nonempty string.

THE HALT'S TRIAGE (ludics-lite#796). While a HALT marker stands under the state root, a new
reservation (reserve, run, window) is admitted only when its request carries `triage_reason`, and
the record keeps the halt's generation as `halt_identity`; a dispatch of a triage record from
another or an ended halt is refused. The halt's TRIAGE is every record not concluded whose
`halt_identity` is the current generation. One owner holds it, on several boxes: a payload may
carry `"triage_boxes": [<box>, ...]` BESIDE the request (as THE CHECKOUT is, and for its reason:
an older copy of this module refuses a request field it does not know, and would refuse the whole
ledger), only with `triage_reason` -- a nonempty list of distinct canonical FLEET_BOXES entries
naming the request's own execution host -- and the record keeps it as a top-level field, fixed for
the record's life (a retry names the same list or is refused). A record without one is a triage of
its own host alone (every triage record before #796). With the triage empty, a triage request
founds it. Otherwise it is admitted only when it names the triage's one `worker`, the same SET of
boxes as every record in the triage (the list is fixed by the triage's first record for as long as
any of its records is outstanding), and a host no record of the triage is outstanding on: one
triage record per box. Every other request is refused, naming the owner, the boxes and the records.
The boundary, and nothing else: it holds one owner (the exact `worker` string) per halt generation,
one record per box, and boxes drawn from the coordinator's own list. It does not verify that the red
reproduces on those boxes (the coordinator's statement), that `worker` is the board's triage worker,
or anything about records dispatched before the halt: the halt refuses new reservations and
dispatch, never running work, so their slot batches and legs go on (`execution leg` reads no
halt). Once every record of the triage is concluded, the next triage request founds a new one; a
later halt's triage ignores this one's records (another generation), which stay outstanding until
concluded like any record.
"""
import contextlib
import fcntl
import io
import json
import math
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, NoReturn, cast

type Record = dict[str, Any]
"""One execution record, or a request inside one, as JSON decodes it: validated by
`validate_record`/`validate_request` before anything reads a field."""


def refuse(message: str) -> NoReturn:
    raise ValueError(message)


def as_object(value: Any) -> Record | None:
    """The decoded JSON value as an object, or None when it is anything else."""
    return cast(Record, value) if isinstance(value, dict) else None


def nonempty(obj: Record, keys: list[str]) -> None:
    for key in keys:
        if not isinstance(obj.get(key), str) or not obj[key].strip():
            refuse(f"{key} must be a nonempty string")


REQUEST_FIELDS = {"request_id", "wave", "worker", "transport", "purpose",
                  "agent_host", "execution_host", "repository", "requested_revision", "kind"}
OPTIONAL_FIELDS = {"issue", "triage_reason", "standing", "integration"}
ISSUE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*")
STATES = {"reserved", "launching", "running", "uncertain", "suspended", "concluded"}
SUSPENDABLE = STATES - {"suspended", "concluded"}   # what `suspended_from` may name
HEAD_OF = "head-of:"
OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def head_of_branch(revision: str) -> str | None:
    """The branch a `head-of:<branch>` revision follows, or None when it is not one well-formed
    branch name (the grammar is the header's)."""
    branch = revision[len(HEAD_OF):] if revision.startswith(HEAD_OF) else ""
    return branch if ref_name_ok(branch) else None


def ref_name_ok(name: str) -> bool:
    """One branch name within `[A-Za-z0-9._/-]`, by git-check-ref-format's rules there: not `HEAD`,
    no leading `-`, no `..`, and each `/` component nonempty, not starting with `.` and not ending in `.` or
    `.lock`."""
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", name) or name.startswith("-") or ".." in name or name == "HEAD":
        return False
    return all(part and not part.startswith(".") and not part.endswith((".", ".lock")) for part in name.split("/"))


def bound_commit(record: Record) -> str | None:
    """THE BINDING (see the header): the commit a record's evidence must name, or None when it is
    bound to none. Read defensively, as `execution leg` hands it a record off a listing."""
    resolved = record.get("resolved_revision")
    if isinstance(resolved, str) and OBJECT_ID.fullmatch(resolved):
        return resolved
    request = as_object(record.get("request"))
    if request is None or request.get("standing") is True:
        return None
    requested = request.get("requested_revision")
    return requested if isinstance(requested, str) and OBJECT_ID.fullmatch(requested) else None


def check_binding(record: Record, data: Record, action: str) -> None:
    """THE BINDING's refusal (see the header) of a payload's observed_sha, named or inherited."""
    bound = bound_commit(record)
    if bound is None:
        return
    named = "observed_sha" in data
    inherits = action == "conclude" and data.get("verdict") != "not-launched"
    sha = data.get("observed_sha") if named else record.get("observed_sha") if inherits else None
    if sha is None or sha == bound:
        return
    what = f"observed_sha {sha}" if named else f"the recorded observed_sha {sha}, which this conclusion inherits,"
    if "resolved_revision" in record:
        # The commit a head-of request was assigned is the one its evidence is about.
        refuse(f"{what} is not {bound}, the commit {record['request']['requested_revision']} was resolved to at assignment")
    refuse(f"{what} is not {bound}, the exact commit non-standing request {record['request_id']} reserved "
           f"(ludics-lite#634): evidence at another commit is another request's -- reserve that run under a new "
           f"request id (a deliberate re-pin), and conclude this one at {bound} (cancelled, evidence naming the "
           f"new id) or not-launched if nothing ran")


def resolve_dispatch(record: Record, resolved: Any, event: Record) -> None:
    """The dispatch step's `resolved_revision` (see the header): required, as an exact object ID,
    for a head-of request, and refused for any other."""
    if record["request"]["requested_revision"].startswith(HEAD_OF):
        if not isinstance(resolved, str) or not OBJECT_ID.fullmatch(resolved):
            refuse(f"{record['request']['requested_revision']} is resolved at assignment: the dispatch must carry "
                   f"resolved_revision, the exact commit the branch names now (fleet-worker.sh reads it off GitHub)")
        record["resolved_revision"] = resolved
        event["resolved_revision"] = resolved
    elif resolved is not None:
        refuse("resolved_revision is only for a head-of:<branch> request")


def validate_request(data: Any) -> None:
    request = as_object(data)
    if request is None or set(request) - REQUEST_FIELDS - OPTIONAL_FIELDS:
        refuse("unknown reservation fields or invalid request")
    nonempty(request, list(REQUEST_FIELDS))
    for key in ("issue", "triage_reason"):
        if key in request:
            nonempty(request, [key])
    if request["kind"] not in {"correctness", "measurement"}:
        refuse("kind must be correctness or measurement")
    if request["requested_revision"].startswith(HEAD_OF) and head_of_branch(request["requested_revision"]) is None:
        refuse(f"requested_revision {request['requested_revision']!r} is not head-of:<one branch name>")
    if "standing" in request:
        # Loud and explicit rather than read off the `-iterate` id convention: a mistyped id
        # must not silently escape the cap, and `execution list` shows the exemption as a field.
        if request["standing"] is not True:
            refuse("standing must be true when present")
        if request["kind"] != "correctness":
            refuse("only a correctness reservation can be standing")
    if request["transport"] not in {"subagent", "app", "cli", "coordinator"}:
        refuse("invalid transport")
    if "integration" in request:
        # A claim the base gate acts on, so only the shape an integration run has may make it.
        if request["integration"] is not True:
            refuse("integration must be true when present")
        if request["kind"] != "correctness" or request["transport"] != "coordinator" or request.get("standing"):
            refuse("only a coordinator's non-standing correctness reservation can be an integration run")


ABSOLUTE = re.compile(r"/|[A-Za-z]:[/\\]")


def checkout_ok(value: Any) -> str:
    """THE CHECKOUT's shape (see the header): a nonempty string, absolute as POSIX or as a drive letter."""
    if not isinstance(value, str) or not value.strip() or not ABSOLUTE.match(value):
        refuse(f"checkout {json.dumps(value)} must be an absolute path on the execution host (POSIX, or a drive letter)")
    return value


def triage_boxes_ok(value: Any, request: Record) -> list[str]:
    """THE HALT'S TRIAGE's box list (see the header), by its shape: only beside a `triage_reason`
    request, a nonempty list of distinct nonempty strings naming the request's execution host."""
    if "triage_reason" not in request:
        refuse("triage_boxes is only for a triage_reason reservation (under a halt)")
    if (not isinstance(value, list) or not value
            or not all(isinstance(box, str) and box.strip() for box in cast(list[Any], value))):
        refuse(f"triage_boxes {json.dumps(value)} must be a nonempty list of box names")
    boxes = cast(list[str], value)
    if len(set(boxes)) != len(boxes):
        refuse(f"triage_boxes {json.dumps(boxes)} names a box twice")
    if request["execution_host"] not in boxes:
        refuse(f"execution_host {request['execution_host']} is not one of its triage_boxes {', '.join(boxes)}")
    return boxes


def triage_boxes_of(record: Record) -> list[str]:
    """The boxes a triage record's triage spans: its list, else its own host (THE HALT'S TRIAGE)."""
    return cast(list[str], record.get("triage_boxes") or [record["request"]["execution_host"]])


def check_triage(request: Record, boxes: list[str] | None, records: dict[str, Record], halt_identity: str) -> None:
    """Admit a new triage request into the current halt's triage, or refuse (THE HALT'S TRIAGE)."""
    members = sorted((r for r in records.values()
                      if r["state"] != "concluded" and halt_generation(r.get("halt_identity")) == halt_identity),
                     key=lambda r: r["request_id"])
    if not members:
        return
    owners = sorted({r["request"]["worker"] for r in members})
    spans = {frozenset(triage_boxes_of(r)) for r in members}
    held = ", ".join(f"{r['request_id']} on {r['request']['execution_host']}" for r in members)
    span = ", ".join(sorted({box for boxes_ in spans for box in boxes_}))
    exists = f"an outstanding triage assignment already exists (owner {', '.join(owners)}; boxes {span}; {held})"
    if owners != [request["worker"]]:
        refuse(f"{exists}: the halt's triage has one owner, so worker {request['worker']} is refused "
               f"until those records conclude")
    wanted = frozenset(boxes or [request["execution_host"]])
    if spans != {wanted}:
        refuse(f"{exists}: a record of the triage names the same triage_boxes, fixed by its first record "
               f"while any of its records is outstanding, not {', '.join(sorted(wanted))}")
    here = [r["request_id"] for r in members if r["request"]["execution_host"] == request["execution_host"]]
    if here:
        refuse(f"{exists}: the triage already holds {here[0]} on {request['execution_host']} (one triage record per box)")


def check_issue(request: Record) -> None:
    """A NEW request's `issue` (see the header): absent, or one issue spelled `owner/name#N`."""
    if "issue" in request and not ISSUE.fullmatch(request["issue"]):
        refuse(f"issue {request['issue']!r} is not one issue spelled owner/name#N: name the issue the work is for, "
               "or omit the field (a post-wave task, an integration run) and say what the work is in purpose")


def validate_record(data: Any, path: Path) -> Record:
    record = as_object(data)
    if record is None:
        refuse(f"invalid execution record: {path}")
    nonempty(record, ["request_id", "coordinator", "lease_token", "state", "created_at", "updated_at"])
    if record["request_id"] != path.stem or record["state"] not in STATES:
        refuse(f"invalid execution record: {path}")
    validate_request(record.get("request"))
    if record["request"]["request_id"] != record["request_id"]:
        refuse(f"mismatched request identity: {path}")
    history = record.get("history")
    if not isinstance(history, list) or not history:
        refuse(f"missing execution history: {path}")
    for item in cast(list[Any], history):
        event = as_object(item)
        if event is None or as_object(event.get("data")) is None:
            refuse(f"invalid execution history: {path}")
        nonempty(event, ["at", "coordinator", "action"])
    for key in ("remote_checkout", "handle", "log", "observed_sha", "verdict", "halt_identity"):
        if key in record:
            nonempty(record, [key])
    if "checkout" in record:
        try:
            checkout_ok(record["checkout"])
        except ValueError:
            refuse(f"invalid checkout: {path}")
    if "triage_boxes" in record:
        try:
            triage_boxes_ok(record["triage_boxes"], record["request"])
        except ValueError:
            refuse(f"invalid triage boxes: {path}")
    if "observed_sha" in record and not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", record["observed_sha"]):
        refuse(f"invalid observed SHA: {path}")
    if "resolved_revision" in record and not (isinstance(record["resolved_revision"], str)
                                              and OBJECT_ID.fullmatch(record["resolved_revision"])
                                              and record["request"]["requested_revision"].startswith(HEAD_OF)):
        refuse(f"invalid resolved revision: {path}")
    # A suspension is exactly the state and its two fields, on a standing record (see the header).
    if record["state"] == "suspended":
        nonempty(record, ["suspended_by", "suspended_from"])
        if record["suspended_from"] not in SUSPENDABLE or not record["request"].get("standing"):
            refuse(f"invalid suspension: {path}")
    elif {"suspended_by", "suspended_from"} & set(record):
        refuse(f"suspension fields on a record that is not suspended: {path}")
    if "window" in record and (record["window"] is not True or record["request"]["kind"] != "measurement"):
        refuse(f"invalid measurement window: {path}")
    if {"deadline", "deadline_at"} & set(record):
        # THE WINDOW'S DEADLINE: both or neither, only on a window, and `deadline_at` exactly its
        # creation plus `deadline`, so the listing's time left is never past the cap.
        try:
            seconds = deadline_ok(record.get("deadline"))
            at = datetime.fromisoformat(record["deadline_at"]) if isinstance(record.get("deadline_at"), str) else None
            due = datetime.fromisoformat(record["created_at"]) + timedelta(seconds=seconds)
        except (ValueError, OverflowError):
            at = due = None
        if at is None or at.tzinfo is None or at != due or record.get("window") is not True:
            refuse(f"invalid window deadline: {path}")
    if record["state"] == "concluded":
        nonempty(record, ["verdict", "log"])
        if record["verdict"] not in {"pass", "fail", "timeout", "cancelled", "not-launched"}:
            refuse(f"invalid terminal verdict: {path}")
        if record["verdict"] != "not-launched":
            nonempty(record, ["observed_sha", "remote_checkout", "handle"])
    return record


WINDOW_DEADLINE_MAX = 7 * 24 * 3600   # a week: longer is no window, and any datetime holds it


def deadline_ok(value: Any) -> int:
    """A window's deadline: a positive whole number of seconds, never a boolean, at most
    ``WINDOW_DEADLINE_MAX`` (THE WINDOW'S DEADLINE)."""
    if type(value) is not int or not 1 <= value <= WINDOW_DEADLINE_MAX:
        refuse(f"a window's deadline must be a whole number of seconds from 1 to {WINDOW_DEADLINE_MAX},"
               f" not {json.dumps(value)}")
    return value


def sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def halt_generation(marker: str | None) -> str | None:
    if marker is None:
        return None
    first_line = marker.splitlines()[0] if marker.splitlines() else ""
    match = re.match(r"^\S+ id=(\S+) ", first_line)
    # Also recognizes records saved by the earlier full-marker representation.
    return match.group(1) if match else first_line


def correctness_slots(spec: str, canonical_hosts: set[str]) -> dict[str, int]:
    """`<box>=<n>` pairs; a box the spec does not name has one slot."""
    slots: dict[str, int] = {}
    for pair in spec.split():
        box, _, count = pair.partition("=")
        if not box or not count.isdigit() or int(count) < 1:
            refuse(f"FLEET_BOX_CORRECTNESS_SLOTS entry must be <box>=<positive n>: {pair}")
        if box not in canonical_hosts:
            refuse(f"FLEET_BOX_CORRECTNESS_SLOTS names {box}, which is not in FLEET_BOXES")
        slots[box] = int(count)
    return slots


def endpoint_boxes(spec: str) -> dict[str, str]:
    """The endpoint map as {casefolded alias: box}; each row is `<box> <alias>...`."""
    boxes: dict[str, str] = {}
    for row in spec.splitlines():
        words = row.split()
        for alias in words:
            owner = boxes.setdefault(alias.casefold(), words[0])
            if owner != words[0]:
                refuse(f"the endpoint map puts {alias} on both {owner} and {words[0]}; fix ENDPOINT_MAP in wake-lab.sh")
    return boxes


def check_one_entry_per_box(roster: list[str], map_spec: str) -> None:
    """Refuse a roster naming two aliases of one physical box (see the header)."""
    boxes = endpoint_boxes(map_spec)
    seen: dict[str, str] = {}
    for entry in roster:
        box = boxes.get(entry.casefold(), entry.casefold())
        other = seen.setdefault(box, entry)
        if other != entry:
            refuse(f"FLEET_BOXES lists {other} and {entry}, two aliases of the one box {box}: a measurement "
                   f"on one would not exclude a run on the other; keep one entry per physical box")


def on_one_box(selected: list[Record], host: str, boxes: str, map_spec: str) -> list[Record]:
    """`list --host` (ludics-lite#557): the records whose execution host is the same box as `host`,
    by the one-box rule of the header (the endpoint map's rows, then case), so an alias (`rog`)
    selects its roster entry's (`rog-nv-linux`) records. A host that is no roster entry's box is
    refused rather than answered with an empty list a typo would read as an idle box."""
    wanted = box_key(host, map_spec)
    if wanted not in {box_key(entry, map_spec) for entry in boxes.split()}:
        refuse(f"list --host {host}: no FLEET_BOXES entry ({boxes}) is that box, by the endpoint map or by case")
    return [record for record in selected if box_key(record["request"]["execution_host"], map_spec) == wanted]


def box_key(name: str, map_spec: str) -> str:
    """Which box ``name`` is, by the one-box rule of the header: its endpoint-map row, then case."""
    return endpoint_boxes(map_spec).get(name.casefold(), name).casefold()


LANE_LOCKS: list[int] = []   # lane-lock descriptors held SHARED until this process exits (see the header)


def check_lab_host(host: str, box: str, anchor: str, lab: str) -> None:
    """Refuse unless this anchor is the machine whose lock directory holds the lab's lane locks."""
    if not anchor or not lab:
        refuse(f"{host} is lab box {box}, and the anchor's and lab host's names were not passed, so this "
               f"anchor cannot be shown to hold the lab's lane locks")
    if anchor.casefold() != lab.casefold():
        refuse(f"{host} is lab box {box}, whose lane lock is a flock on the lab host {lab} (FLEET_LAB_HOST), "
               f"but this registry, on the anchor {anchor} (FLEET_ANCHOR), reads {anchor}'s lock directory, "
               f"so a running lane could not be seen: the anchor must be the machine that runs "
               f"wake-lab.sh and the sweep, and FLEET_LAB_HOST names that machine")
    site = Path(os.environ.get("WAKE_LAB_HOSTS") or Path.home() / ".config/wake-lab/hosts.sh")
    if not (site.is_file() and os.access(site, os.R_OK)):
        refuse(f"{host} is lab box {box}, and the anchor {anchor}, declared the lab host, has no readable "
               f"wake-lab site file ({site}), so it cannot be the machine whose wake-lab.sh drives the "
               f"lab and holds its lane locks: a running lane could not be seen")


def check_lane_lock(host: str, map_spec: str, anchor: str, lab: str) -> None:
    """Refuse a measurement on a box whose lab LANE lock is held; hold it shared if free."""
    box = endpoint_boxes(map_spec).get(host.casefold())
    if box is None:
        return
    check_lab_host(host, box, anchor, lab)
    directory = Path(os.environ.get("WAKE_LAB_LOCK_DIR") or Path.home() / ".local/state/wake-lab")
    path = directory / (box + ".lock")
    try:
        directory.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_RDONLY | os.O_CREAT, 0o644)
    except OSError:
        return
    try:
        fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            with open(descriptor, errors="replace", closefd=False) as stream:
                line = stream.readline()
        except OSError:
            line = ""
        os.close(descriptor)
        holder = re.sub(r"[\x00-\x1f\x7f]", "", line)[:200] or "an unnamed holder"
        refuse(f"{host} is lab box {box}, whose lane lock is held by {holder} ({path}): a measurement "
               f"needs the box to itself; wait for that lane to end (`wake-lab.sh status {box}`)")
    except OSError as exc:
        os.close(descriptor)
        refuse(f"{host} is lab box {box}, whose lane lock {path} could not be probed ({exc}), so a sweep "
               f"lane there cannot be ruled out")
    LANE_LOCKS.append(descriptor)


def check_capacity(data: Record, records: dict[str, Record], canonical_hosts: set[str], slots_spec: str,
                   window: bool = False) -> str | None:
    """Refuse when the requested host cannot take this assignment beside the outstanding ones.

    Returns the open measurement window a standing request is queued behind, if any."""
    host, kind = data["execution_host"], data["kind"]
    slots = correctness_slots(slots_spec, canonical_hosts)
    outstanding = [r for r in records.values()
                   if r["state"] != "concluded" and r["request"]["execution_host"] == host]
    if window:
        # A window suspends the standing records and nothing else (see the header).
        outstanding = [r for r in outstanding if not r["request"].get("standing")]
    if not outstanding:
        return None
    owners = ", ".join(f"{r['request']['worker']} request={r['request_id']} coordinator={r['coordinator']}"
                       for r in outstanding)
    measuring = [r for r in outstanding if r["request"]["kind"] == "measurement"]
    if window:
        opened = [r["request_id"] for r in measuring if r.get("window")]
        if opened:
            refuse(f"measurement window {opened[0]} is already open on {host}; open the next one when it concludes")
        refuse(f"box owned by {owners} (a measurement window suspends only standing reservations, "
               f"and needs {host} otherwise to itself)")
    if kind == "measurement":
        hint = ("; every one is standing, which `fleet-worker.sh execution window` suspends for the measurement"
                if all(r["request"].get("standing") for r in outstanding) else "")
        refuse(f"box owned by {owners} (measurement needs {host} to itself{hint})")
    if measuring:
        windows = [r["request_id"] for r in measuring if r.get("window")]
        if windows and data.get("standing"):
            return windows[0]
        refuse(f"box owned by {owners} (a measurement holds {host} exclusively)")
    # Standing iteration records hold nothing at run time, so they neither fill a slot nor can
    # be refused for want of one; they remain outstanding for measurement exclusivity above.
    if data.get("standing"):
        return None
    counted = [r for r in outstanding if not r["request"].get("standing")]
    cap = slots.get(host, 1)
    if len(counted) >= cap:
        refuse(f"box owned by {owners} (correctness slots {len(counted)}/{cap} on {host} taken)")
    return None


def suspend(record: Record, window: str, now: str, coordinator: str) -> None:
    """Move a standing record into the window's suspension (see the header)."""
    record["suspended_from"] = record["state"]
    record["state"] = "suspended"
    record["suspended_by"] = window
    record["updated_at"] = now
    record["history"].append({"at": now, "coordinator": coordinator, "action": "suspend", "data": {
        "request_id": record["request_id"], "evidence": f"suspended by measurement window {window}"}})


class Gap(ValueError):
    """A new window inside the gap after its box's last measurement (see the header): not a
    refusal of the request, an answer the near side waits out."""

    def __init__(self, answer: Record, line: str) -> None:
        super().__init__(line)
        self.answer = answer


def check_gap(host: str, gap: int, records: dict[str, Record], now: datetime, waiting: list[str]) -> None:
    """Raise Gap when a measurement on ``host`` concluded less than ``gap`` seconds before ``now``
    and batches are waiting for the box (``waiting``, the waiter ids ``fresh_waiters`` read; see
    the header)."""
    if gap <= 0 or not waiting:
        return
    ended: list[tuple[datetime, str]] = []
    for r in records.values():
        if (r["state"] == "concluded" and r["request"]["execution_host"] == host
                and r["request"]["kind"] == "measurement"):
            try:
                at = datetime.fromisoformat(r["updated_at"])
            except ValueError:
                refuse(f"{r['request_id']}: updated_at {r['updated_at']!r} is no ISO 8601 time, so the gap"
                       f" after it cannot be measured")
            ended.append((at if at.tzinfo is not None else at.replace(tzinfo=timezone.utc), r["request_id"]))
    if not ended:
        return
    at, after = max(ended)
    ago = (now - at).total_seconds()
    if ago >= gap:
        return
    # A conclusion stamped ahead of this clock (one stepped back) waits the gap and no more: the near
    # side asks again with the gap less what it has waited, so its whole wait is the gap at most.
    wait = min(gap, max(1, int(gap - ago + 0.999)))
    raise Gap({"gap": {"box": host, "after": after, "ago": max(0, int(ago)), "gap": gap, "wait": wait,
                       "waiting": waiting}},
              f"measurement {after} concluded on {host} {max(0, int(ago))}s ago, and batches are waiting for"
              f" {host} ({', '.join(waiting)}): they get {gap}s to take its slots before the next window"
              f" (ludics-lite#667, #719); {wait}s to go")


WAITER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
WAITER_FIELDS = {"id", "command", "ttl"}   # and exactly one of `box` and `request`
WAITER_TTL_MAX = 3600


def waiter_time(value: Any) -> datetime | None:
    """A waiter file's ISO 8601 time, as UTC when naive; None when it is not one."""
    if not isinstance(value, str):
        return None
    try:
        at = datetime.fromisoformat(value)
    except ValueError:
        return None
    return at if at.tzinfo is not None else at.replace(tzinfo=timezone.utc)


def fresh_waiters(directory: Path, host: str, map_spec: str, now: datetime) -> list[str]:
    """The ids of the waiters on ``host``'s box whose heartbeat has not expired at ``now`` (THE
    WAITERS in the header). Fail-closed toward the gap: a waiter file this cannot read or parse
    counts as a waiter on every box, named by its file, since the cost of a wrong guess either way
    is a gap paid (60 s) against a batch starved (its whole --wait-window bound)."""
    if not directory.is_dir():
        return []
    wanted = box_key(host, map_spec)
    waiting: list[str] = []
    for path in sorted(directory.glob("*.json")):
        try:
            data = as_object(json.loads(path.read_text()))
        except FileNotFoundError:
            continue   # released or expired since the listing: nobody waits there
        except (OSError, ValueError):
            data = None
        expires = waiter_time(data.get("expires")) if data is not None else None
        box = data.get("box") if data is not None else None
        if data is None or expires is None or not isinstance(box, str):
            waiting.append(f"{path.name} (unreadable)")
        elif expires > now and box_key(box, map_spec) == wanted:
            waiting.append(path.stem)
    return waiting


def record_waiter(directory: Path, waiter: Any, boxes: str, map_spec: str, now: datetime,
                  records: dict[str, Record]) -> None:
    """``wait``'s heartbeat (THE WAITERS in the header): one file per waiter, replaced whole, its
    expiry ``ttl`` seconds from this anchor's clock; and every other waiter file already expired
    is removed. A waiter named by ``request`` waits for that record's execution host; an unknown
    request records nothing (its caller refuses it on the listing)."""
    data = as_object(waiter)
    if data is not None and set(data) == {"id", "done"}:
        # The waiter no longer needs the gap (it holds its slot, or it was refused): its file goes.
        if data["done"] is not True or not isinstance(data["id"], str) or not WAITER_ID.fullmatch(data["id"]):
            refuse("a waiter that is done is {id, done: true}")
        with contextlib.suppress(FileNotFoundError):
            (directory / (data["id"] + ".json")).unlink()
        return
    if (data is None or not WAITER_FIELDS <= set(data) or set(data) - WAITER_FIELDS - {"box", "request"}
            or ("box" in data) == ("request" in data)):
        refuse("a waiter is {box or request, id, command, ttl}")
    nonempty(data, ["id", "command", "box" if "box" in data else "request"])
    if "request" in data:
        known = records.get(data["request"])
        if known is None:
            return
        data = {**data, "box": known["request"]["execution_host"]}
    if not WAITER_ID.fullmatch(data["id"]):
        refuse("invalid waiter id")
    ttl = data["ttl"]
    if type(ttl) is not int or not 0 < ttl <= WAITER_TTL_MAX:
        refuse(f"a waiter's ttl must be a whole number of seconds from 1 to {WAITER_TTL_MAX}")
    if box_key(data["box"], map_spec) not in {box_key(entry, map_spec) for entry in boxes.split()}:
        refuse(f"waiter box {data['box']}: no FLEET_BOXES entry ({boxes}) is that box, by the endpoint map or by case")
    # Under `waiters/.lock`, which the caller holds (`lock_waiters`): the removal of expired files
    # and the renewal of one are serialized with each other and with a window's admission. Without
    # it, one waiter could read another's file expired, the owner renew it, and the first remove
    # the renewal, unseen until the next poll.
    for path in directory.glob("*.json"):
        try:
            existing = as_object(json.loads(path.read_text()))
        except (OSError, ValueError):
            continue   # unreadable: fresh_waiters counts it; a person removes it
        expires = waiter_time(existing.get("expires")) if existing is not None else None
        if expires is not None and expires <= now:
            with contextlib.suppress(FileNotFoundError):
                path.unlink()
    record = {"box": data["box"], "id": data["id"], "command": data["command"][:300], "seen": now.isoformat(),
              "expires": (now + timedelta(seconds=ttl)).isoformat()}
    fd, temporary = tempfile.mkstemp(prefix=".waiter-", dir=directory)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream)
            stream.write("\n")
        os.replace(temporary, directory / (data["id"] + ".json"))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def publish(directory: Path, record: Record) -> None:
    """Write one record atomically and durably: exactly one `os.replace` per record."""
    directory.mkdir(exist_ok=True)
    # Sync even on retry: an earlier failed sync may have left the new directory visible.
    sync_directory(directory.parent)
    fd, temporary = tempfile.mkstemp(prefix=".execution-", dir=directory)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / (record["request_id"] + ".json"))
        sync_directory(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def payload_word(word: str) -> str:
    """The JSON payload argv names: the word itself, or for `-` the one JSON string on fd 3 (the
    header). boardstore.py carries the same reader: each shipped module is self-contained."""
    if word != "-":
        return word
    try:
        with open(3, "rb") as stream:
            data = stream.read()
    except OSError as exc:
        raise ValueError(f"payload `-` names file descriptor 3, which cannot be read ({exc.strerror})") from None
    text: Any = json.loads(data.decode("ascii"))
    if not isinstance(text, str):
        raise ValueError("the payload on file descriptor 3 must be one JSON string")
    return text


def load_records(directory: Path) -> dict[str, Record]:
    """Every record under ``executions/``, validated: a corrupt record blocks dispatch instead of
    silently making its box available."""
    records: dict[str, Record] = {}
    if directory.exists():
        for path in sorted(directory.glob("*.json")):
            records[path.stem] = validate_record(json.loads(path.read_text()), path)
    return records


WAITER_LOCKS: list[int] = []   # `waiters/.lock`, held until `run` returns (THE WAITERS)


def lock_waiters(directory: Path) -> None:
    """Take ``waiters/.lock`` exclusively until `run` returns: a heartbeat with the listing
    read after it, and a window from its waiter check through its publication, are serialized, so
    either the window sees the heartbeat or the listing sees the window (THE WAITERS)."""
    # parents: on a fresh anchor no lease has created the state root yet, and `wait` takes none.
    directory.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(directory / ".lock", os.O_CREAT | os.O_RDWR, 0o644)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    WAITER_LOCKS.append(descriptor)


LOCK_WAIT = 120   # seconds an action waits for `executions.lock` before it is refused (THE SNAPSHOT)
SNAPSHOT_LOCKS: list[int] = []   # `executions.lock`, held until `run` returns (THE SNAPSHOT)
READERS = {"list", "wait"}   # the actions that take it SHARED; every other one takes it EXCLUSIVE


def lock_snapshot(root: Path, shared: bool) -> None:
    """Take ``executions.lock`` under the state root, SHARED for a listing and EXCLUSIVE for any
    other action, polling for at most ``LOCK_WAIT`` seconds (THE SNAPSHOT in the header)."""
    # parents: on a fresh anchor no lease has created the state root yet, and `list` takes none.
    root.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(root / "executions.lock", os.O_CREAT | os.O_RDWR, 0o644)
    mode = (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB
    give_up, pause = time.monotonic() + LOCK_WAIT, 0.01
    while True:
        try:
            fcntl.flock(descriptor, mode)
            break
        except BlockingIOError:
            if time.monotonic() >= give_up:
                os.close(descriptor)
                refuse(f"the registry is busy: another action has held {root / 'executions.lock'} for {LOCK_WAIT}s"
                       " (ludics-lite#711); retry, and if it persists find the registry process holding it")
            time.sleep(pause)
            pause = min(pause * 2, 0.25)
        except OSError:
            os.close(descriptor)
            raise
    SNAPSHOT_LOCKS.append(descriptor)


def unlock_snapshot() -> None:
    """Release `executions.lock`, and `waiters/.lock` with it: `run` does, before it says anything."""
    while SNAPSHOT_LOCKS:
        os.close(SNAPSHOT_LOCKS.pop())
    while WAITER_LOCKS:
        os.close(WAITER_LOCKS.pop())


def time_left(deadline_at: str, now: datetime) -> int:
    """A listing's `deadline_left`: whole seconds to `deadline_at` by this clock, rounded UP while any
    time is left, so a waiter never gives up before the deadline; 0 once it has passed."""
    return max(0, math.ceil((datetime.fromisoformat(deadline_at) - now).total_seconds()))


def main(argv: list[str]) -> None:
    root, action, coordinator, token, word, boxes = argv[1:7]
    raw = payload_word(word)
    slots_spec = argv[7] if len(argv) > 7 else ""
    map_spec = argv[8] if len(argv) > 8 else ""
    anchor, lab = (argv[9:11] + ["", ""])[:2]
    directory = Path(root) / "executions"
    # THE SNAPSHOT (ludics-lite#711): before anything reads the records, and before `wait`'s
    # `waiters/.lock` (the lock order in the header).
    lock_snapshot(Path(root), shared=action in READERS)
    if action == "wait":
        # THE WAITERS (ludics-lite#719): the heartbeat, then -- under the same lock, which an admitted
        # window holds until it is published -- the listing `list` gives, read after it.
        payload = as_object(json.loads(raw))
        if payload is None or "waiter" not in payload:
            refuse("a wait payload is {waiter, ...list options}")
        lock_waiters(Path(root) / "waiters")
        record_waiter(Path(root) / "waiters", payload["waiter"], boxes, map_spec, datetime.now(timezone.utc),
                      load_records(directory))
        raw = json.dumps({key: value for key, value in payload.items() if key != "waiter"})
        action = "list"
    records = load_records(directory)
    if action == "list":
        options = as_object(json.loads(raw))
        if (options is None or set(options) - {"active", "compact", "host"}
                or any(type(value) is not bool for key, value in options.items() if key != "host")):
            refuse("list options must be active/compact booleans and a host")
        if "host" in options:
            nonempty(options, ["host"])
        flags = options
        # Validate the entire ledger above before filtering: a compact view must not hide
        # corrupt ownership evidence, including a malformed terminal record.
        selected = [record for record in records.values()
                    if not flags.get("active") or record["state"] != "concluded"]
        if "host" in flags:
            selected = on_one_box(selected, flags["host"], boxes, map_spec)
        if flags.get("compact"):
            selected = [{key: value for key, value in record.items()
                         if key not in {"history", "lease_token"}} for record in selected]
        # THE WINDOW'S DEADLINE: the time left by THIS clock, so a waiter on another host compares no
        # clocks (a listing's field only, never written to a record).
        now = datetime.now(timezone.utc)
        selected = [record | {"deadline_left": time_left(record["deadline_at"], now)} if "deadline_at" in record
                    else record for record in selected]
        print(json.dumps(selected, indent=None if flags.get("compact") else 2))
        return
    decoded: Any = json.loads(raw)
    window_box: str | None = None
    window_gap = 0
    window_deadline: int | None = None   # THE WINDOW'S DEADLINE (see the header)
    if action == "window":
        payload = as_object(decoded)
        if payload is None or set(payload) - {"gap", "deadline"} != {"box", "request"}:
            refuse("window payload must be {box, request}, with an optional gap and deadline")
        nonempty(payload, ["box"])
        gap_value = payload.get("gap", 0)
        if type(gap_value) is not int or gap_value < 0:
            refuse("a window's gap must be a whole number of seconds")
        if "deadline" in payload:
            window_deadline = deadline_ok(payload["deadline"])
        window_box, window_gap, decoded = cast(str, payload["box"]), gap_value, payload["request"]
    request_data = as_object(decoded)
    if request_data is None:
        refuse("request must be a JSON object")
    data: Record = request_data
    nonempty(data, ["request_id"])
    identity = data["request_id"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", identity):
        refuse("invalid request_id")
    # APFS commonly preserves case but aliases filenames differing only by case.
    # Preserve existing mixed-case identities; never publish another spelling over them.
    if any(name.casefold() == identity.casefold() and name != identity for name in records):
        refuse("request_id collides with an existing identity by case")
    clock = datetime.now(timezone.utc)
    now = clock.isoformat()
    halt_path = Path(root) / "HALT"
    halt_identity = halt_generation(halt_path.read_text()) if halt_path.exists() else None
    if halt_identity is not None and not halt_identity.strip():
        refuse("invalid empty halt record")
    record: Record | None = records.get(identity)
    events: list[tuple[str, Record]] = []   # (action, data) pairs appended to the history, in order
    before: list[Record] = []   # other records to publish BEFORE this one (a window's restorations)
    after: list[Record] = []    # other records to publish AFTER this one (a window's suspensions)
    canonical_hosts: set[str] = set()
    if action in {"reserve", "run", "dispatch", "window"}:
        roster = list(dict.fromkeys(boxes.split()))   # a repeated entry is the same entry
        canonical_hosts = set(roster)
        if not canonical_hosts:
            refuse("FLEET_BOXES must name the canonical fleet hosts")
        check_one_entry_per_box(roster, map_spec)
        # A changed roster cannot silently erase ownership recorded under an old alias.
        # Keep reads and evidence/conclusion available to reconcile those records.
        for existing in records.values():
            if existing["state"] != "concluded" and existing["request"]["execution_host"] not in canonical_hosts:
                refuse(f"reconcile noncanonical execution host on request {existing['request_id']} before dispatch")
    if action in {"reserve", "run", "window"}:
        # `run` is reserve + dispatch under one lock: the payload is the reservation, plus an
        # optional `evidence` for the dispatch step (ludics-lite: four calls per execution
        # were a third of a coordinator's tool calls on 2026-09-15). `window` is `run` for a
        # measurement that suspends its box's standing records (see the header).
        # THE CHECKOUT (see the header): beside the request, never in it.
        checkout = data.get("checkout")
        if "checkout" in data:
            checkout_ok(checkout)
        # THE HALT'S TRIAGE's box list rides beside the request as the checkout does (see the header).
        triage_boxes: list[str] | None = data.get("triage_boxes")
        request = {k: v for k, v in data.items() if k not in {"checkout", "triage_boxes"}}
        dispatch_evidence = ("measurement window opened: reserved and dispatched in one step (execution window)"
                             if action == "window" else "reserved and dispatched in one step (execution run)")
        if action in {"run", "window"}:
            request = {k: v for k, v in request.items() if k not in {"evidence", "resolved_revision"}}
            if "evidence" in data:
                nonempty(data, ["evidence"])
                dispatch_evidence = data["evidence"]
        validate_request(request)
        if request["execution_host"] not in canonical_hosts:
            refuse("execution_host must exactly match a canonical FLEET_BOXES entry")
        if action == "window":
            if request["kind"] != "measurement":
                refuse("a window opens for a measurement: kind must be measurement")
            if request["execution_host"] != window_box:
                refuse(f"the window is for {window_box}, but the measurement names {request['execution_host']}")
        if "triage_boxes" in data:
            triage_boxes = triage_boxes_ok(triage_boxes, request)
            for box in triage_boxes:
                if box not in canonical_hosts:
                    refuse(f"triage_boxes entry {box} must exactly match a canonical FLEET_BOXES entry")
        queued: str | None = None      # the open window a standing request is admitted suspended by
        dispatch = action in {"run", "window"}
        if record:
            if record["request"] != request:
                refuse("request_id already names a different assignment")
            if record.get("checkout") != checkout:
                refuse(f"request_id already names a different checkout ({json.dumps(record.get('checkout'))});"
                       f" a reservation's checkout is fixed when it is taken")
            if record.get("triage_boxes") != triage_boxes:
                refuse(f"request_id already names different triage_boxes ({json.dumps(record.get('triage_boxes'))});"
                       f" a triage record's boxes are fixed when it is taken")
            if action == "reserve":
                sync_directory(directory.parent)
                sync_directory(directory)
                print(json.dumps(record, indent=2))
                return
            if action == "window":
                # A retried window never dispatches again: it finishes the suspensions below.
                if not record.get("window"):
                    refuse("request_id already names a measurement that opened no window")
                if record.get("deadline") != window_deadline:
                    refuse(f"request_id already names a window with a different deadline"
                           f" ({json.dumps(record.get('deadline'))}); a window's deadline is fixed when it opens")
                if record["state"] == "concluded":
                    sync_directory(directory.parent)
                    sync_directory(directory)
                    print(json.dumps(record, indent=2))
                    return
                dispatch = False
            else:
                # A repeated `run` never repeats a launch: the connection that dropped after the
                # first one may have started the runner. Only a still-reserved own record proceeds.
                if record["state"] != "reserved":
                    refuse(f"assignment already dispatched (state {record['state']}); reconcile, never run twice")
                if record["lease_token"] != token:
                    refuse("adopted assignment must be reconciled before dispatch")
                # The dispatch step, rechecked: a reservation can wait hours for its launch.
                if record["request"]["kind"] == "measurement":
                    check_lane_lock(record["request"]["execution_host"], map_spec, anchor, lab)
        else:
            check_issue(request)
            if request.get("standing") and checkout is None:
                refuse("a standing reservation must name its checkout: \"checkout\": the worker's worktree, absolute on "
                       "the execution host, which its hand-back's --observed-from must be (ludics-lite#731)")
            halted = halt_identity is not None
            if "triage_reason" in request and not halted:
                refuse("triage reservations require an active halt")
            queued = check_capacity(request, records, canonical_hosts, slots_spec, window=action == "window")
            if request["kind"] == "measurement":
                check_lane_lock(request["execution_host"], map_spec, anchor, lab)
            if halted:
                if "triage_reason" not in request:
                    refuse("fleet halted; ordinary reservations refused (only the named triage_reason reservation is admitted)")
                nonempty(request, ["triage_reason"])
                # One explicitly named owner, not an unrestricted force flag (THE HALT'S TRIAGE).
                check_triage(request, triage_boxes, records, halt_identity)
            if action == "window":
                # Last of the admission checks: a gap answer is retried, and only a window every
                # other check admits may wait for one.
                if window_gap > 0:
                    # Held from this check through the window's publication (THE WAITERS).
                    lock_waiters(Path(root) / "waiters")
                check_gap(request["execution_host"], window_gap, records, clock,
                          fresh_waiters(Path(root) / "waiters", request["execution_host"], map_spec, clock)
                          if window_gap > 0 else [])
            record = {"request_id": identity, "request": request, "coordinator": coordinator,
                      "lease_token": token, "state": "reserved", "created_at": now, "history": []}
            if "triage_reason" in request:
                record["halt_identity"] = halt_identity
            if action == "window":
                record["window"] = True
                if window_deadline is not None:
                    # From this action's own clock, read after any gap: the window opens now.
                    record["deadline"] = window_deadline
                    record["deadline_at"] = (clock + timedelta(seconds=window_deadline)).isoformat()
            if checkout is not None:
                record["checkout"] = checkout
            if triage_boxes is not None:
                record["triage_boxes"] = triage_boxes
            beside = {k: v for k, v in (("checkout", checkout), ("triage_boxes", triage_boxes)) if v is not None}
            events.append(("reserve", {**request, **beside}))
        if dispatch:
            triage = record["request"].get("triage_reason")
            if triage and (halt_identity is None or halt_generation(record.get("halt_identity")) != halt_identity):
                refuse("triage assignment belongs to a different or ended halt")
            if halt_identity is not None and not triage:
                refuse("fleet halted; ordinary dispatch refused")
            record["state"] = "launching"
            dispatched: Record = {"request_id": identity, "evidence": dispatch_evidence}
            resolve_dispatch(record, data.get("resolved_revision"), dispatched)
            events.append(("dispatch", dispatched))
        if queued:
            # Queued behind the open window rather than refused: restored when it concludes.
            record["suspended_from"] = record["state"]
            record["state"] = "suspended"
            record["suspended_by"] = queued
            events.append(("suspend", {"request_id": identity, "evidence": f"queued behind measurement window {queued}"}))
        if action == "window":
            # The measurement is published first: a crash before the suspensions leaves standing
            # records outstanding beside it (refused at run time all the same), which a retried
            # window finishes, never a record suspended by a measurement that does not exist.
            host = request["execution_host"]
            for other in records.values():
                if (other["request_id"] != identity and other["state"] not in {"concluded", "suspended"}
                        and other["request"]["execution_host"] == host and other["request"].get("standing")):
                    suspend(other, identity, now, coordinator)
                    after.append(other)
    else:
        if record is None:
            refuse("unknown request_id")
        if set(data) - {"request_id", "state", "evidence", "observed_sha", "remote_checkout", "handle", "log", "verdict",
                        "execution_host", "resolved_revision"}:
            refuse("unknown evidence fields")
        if "resolved_revision" in data and action != "dispatch":
            refuse("resolved_revision is only valid for dispatch")
        nonempty(data, ["evidence"])
        # Evidence read on a named box binds to the box that was reserved: a run record at the
        # same path on another machine cannot conclude this assignment.
        if "execution_host" in data:
            nonempty(data, ["execution_host"])
            if data["execution_host"] != record["request"]["execution_host"]:
                refuse(f"evidence from {data['execution_host']} cannot conclude an assignment reserved on {record['request']['execution_host']}")
            data = {k: v for k, v in data.items() if k != "execution_host"}
        if "verdict" in data and action != "conclude":
            refuse("verdict is only valid for conclude")
        if "state" in data and action not in {"record", "reconcile"}:
            refuse("state is only valid for record or reconcile")
        if record["state"] == "concluded":
            # Terminal records are immutable; retries of the final payload are harmless.
            if action == "conclude" and record["history"][-1]["data"] == data:
                sync_directory(directory.parent)
                sync_directory(directory)
                print(json.dumps(record, indent=2))
                return
            refuse("assignment already concluded")
        if record["state"] == "suspended" and action != "conclude":
            refuse(f"{identity} is suspended by measurement window {record['suspended_by']}, which restores it "
                   f"when it concludes; conclude it only once its worker has handed back")
        if action == "dispatch":
            if record["state"] != "reserved":
                refuse("dispatch requires reserved state; reconcile an uncertain launch")
            if record["lease_token"] != token:
                refuse("adopted assignment must be reconciled before dispatch")
            triage = record["request"].get("triage_reason")
            if triage and (halt_identity is None or halt_generation(record.get("halt_identity")) != halt_identity):
                refuse("triage assignment belongs to a different or ended halt")
            if halt_identity is not None and not triage:
                refuse("fleet halted; ordinary dispatch refused")
            # Rechecked at dispatch, the moment the timed work starts: a reservation can wait hours
            # for its launch, and a lane harness that reads no registry can take the box meanwhile.
            if record["request"]["kind"] == "measurement":
                check_lane_lock(record["request"]["execution_host"], map_spec, anchor, lab)
            resolve_dispatch(record, data.get("resolved_revision"), {})
            state = "launching"
        elif action == "record":
            if record["state"] not in {"launching", "running", "uncertain"}:
                refuse("record requires dispatch; use reconcile for recovered execution evidence")
            state = data.get("state")
            if state not in {"running", "uncertain"}:
                refuse("record state must be running or uncertain")
        elif action == "reconcile":
            state = data.get("state")
            if state not in {"reserved", "running", "uncertain"}:
                refuse("reconcile state must be reserved, running or uncertain")
            if (state != "reserved" and record["request"]["requested_revision"].startswith(HEAD_OF)
                    and "resolved_revision" not in record):
                # Only a dispatch resolves the branch: an active record without that commit would
                # name none, and any revision would pass for it.
                refuse(f"{record['request']['requested_revision']} was never resolved (no dispatch): reconcile it "
                       f"to reserved and dispatch it, which resolves the branch")
            # reserved means evidence establishes no launch occurred and no process can run.
            record["lease_token"] = token
        elif action == "conclude":
            nonempty(data, ["verdict", "log"])
            if data["verdict"] not in {"pass", "fail", "timeout", "cancelled", "not-launched"}:
                refuse("invalid terminal verdict")
            if data["verdict"] != "not-launched":
                nonempty({**record, **data}, ["observed_sha", "remote_checkout", "handle"])
            state = "concluded"
            record.pop("suspended_by", None)
            record.pop("suspended_from", None)
            # A window's conclusion, whatever its verdict, restores what it suspended, and those
            # records are published first: a crash between leaves the window open with some
            # records restored early (refused at run time all the same), never a record suspended
            # by a concluded measurement.
            for other in records.values():
                if other["state"] == "suspended" and other.get("suspended_by") == identity:
                    other["state"] = other.pop("suspended_from")
                    del other["suspended_by"]
                    other["updated_at"] = now
                    other["history"].append({"at": now, "coordinator": coordinator, "action": "restore", "data": {
                        "request_id": other["request_id"],
                        "evidence": f"measurement window {identity} concluded {data['verdict']}"}})
                    before.append(other)
        else:
            refuse("unknown operation")
        if "observed_sha" in data and not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", data["observed_sha"]):
            refuse("observed_sha must be an exact Git object ID")
        check_binding(record, data, action)
        for key in ("observed_sha", "remote_checkout", "handle", "log", "verdict"):
            if key in data:
                nonempty(data, [key])
                record[key] = data[key]
        record["state"] = state
        events.append((action, data))
    for other in before:
        publish(directory, other)
    if action == "conclude":
        # A conclusion is stamped when it is published, after the restorations: its `updated_at`
        # is when the box reads free, which the gap after it is measured from (see the header).
        now = datetime.now(timezone.utc).isoformat()
    if events:
        record["updated_at"] = now
        for event_action, event_data in events:
            record["history"].append({"at": now, "coordinator": coordinator, "action": event_action, "data": event_data})
        publish(directory, record)
    else:
        # A retried window: its record stands as it was written.
        sync_directory(directory.parent)
        sync_directory(directory)
    for other in after:
        publish(directory, other)
    host = record["request"]["execution_host"]
    if before:
        print(f"EXECUTION WINDOW {host}: {identity} concluded; restored "
              + ", ".join(f"{r['request_id']} ({r['state']})" for r in before), file=sys.stderr)
    if action == "window":
        suspended = sorted(r["request_id"] for r in records.values()
                           if r.get("suspended_by") == identity and r["state"] == "suspended")
        print(f"EXECUTION WINDOW {host}: {identity} open; suspended "
              + (", ".join(suspended) or "nothing (no standing reservation on the box)"), file=sys.stderr)
    print(json.dumps(record, indent=2))


def run(argv: list[str]) -> int:
    """`main` with the registry's refusal contract: one `EXECUTION REFUSED: <why>` line on stderr, exit 1;
    a window inside the gap (see the header) is exit 3, its answer on stdout. Everything an action
    says is buffered and written only once the snapshot lock is released (THE SNAPSHOT): a caller
    that stops reading its pipe then stalls this process alone, never every other action behind
    the lock. The lock is released whatever the outcome, so an in-process caller's next action
    does not wait on it either."""
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            return outcome(argv)
    finally:
        unlock_snapshot()
        sys.stdout.write(out.getvalue())
        sys.stderr.write(err.getvalue())
        sys.stdout.flush()
        sys.stderr.flush()


def outcome(argv: list[str]) -> int:
    """`main`, its refusals and its gap answer said, and its status (`run`'s contract)."""
    try:
        main(argv)
    except Gap as gap:
        print(f"EXECUTION WINDOW {gap.answer['gap']['box']}: {gap}", file=sys.stderr)
        print(json.dumps(gap.answer, separators=(",", ":")))
        return 3
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"EXECUTION REFUSED: {exc}", file=sys.stderr)
        return 1
    return 0


# A program (`python - <argv>` on the anchor, `python registry.py`) or `runpy.run_path`, never an
# import: the in-process suite reads LANE_LOCKS from the namespace runpy returns.
if __name__ in ("__main__", "<run_path>"):
    status = run(sys.argv)
    if status != 0:
        sys.exit(status)
