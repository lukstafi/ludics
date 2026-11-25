"""``wave drive`` and ``wave turn``: the routine answers to a CLI worker's returned turns.

A CLI worker ends its turn for every handoff: a review request, an execution request, a result, the
hand-back. wave-20261111-ocannl's coordinator read 142 such turns by hand, and 140 of them needed no
judgment: 55 hand-backs, 51 review requests, 14 execution requests, 12 results, 6 confirm requests.
Each cost it a handful of tool calls, and every slip it made came from that volume. This driver
answers those turns, so the coordinator is asked only what a rule cannot answer.

    wave drive <wave.json> [--poll <seconds>] [--once]   every CLI worker of the wave, until stopped
    wave turn <wave.json> <task>                          one worker's returned turn, once

WHO IT SERVES. The board's rows whose ``transport`` is ``cli`` and ``kind`` is ``codex`` or
``claude``, with a ``worker`` and an ``agent_host``, in a live state past ``pending``. A native
worker is outside it: its turn returns to its coordinator's own runtime, where no process can
resume it, and the coordinator answers it with the same verbs (``wave review``, ``execution
assign``). A driver that cannot tell two turns apart would answer one twice or never, so each
kind's turns are named by a counter that moves once per turn.

A TURN is a count, of one worker and session. A Codex worker's is its ``resumes`` (``status``'s
field: 0 for its launch, one more for each resume: a Codex turn is one process). A Claude worker's
process outlives its turns (a message is appended to it, and ``resumes`` does not move), so its
count is ``status``'s ``results=``, the turns its stream has ended (its ``result`` events since the
launch, across resumes): turn n is the one that wrote the n-th result, and turn 0 one that has
written none (it died at startup). Its ledger lines carry ``"count": "results"``, and a line
without it is a Codex turn's, so neither numbering is read as the other. A worker launched again
in a task's place, under another name or the same one (``launch --replace``), has a new session
and counts from 0 again, and it does not inherit the turns its predecessor was answered. The
ledger, ``<wave dir>/logs/drive.jsonl``, holds one line per step taken for a task, worker, session
and turn, and a turn whose last line is final (``answered`` or ``attention``) is never read again,
so a restarted driver answers nothing twice. ONE DRIVER per wave: an exclusive ``flock`` on
``logs/drive.lock``, taken without waiting; ``wave turn`` takes it too, so it refuses while a
driver runs.

EACH TICK, for each worker: ``status`` on its box. ``RUNNING`` is left alone. ``EXITED`` (and, for
a Claude worker, ``IDLE``: its process up and its turn ended) with no final ledger line is a
returned turn, and THE TURN'S OWN MESSAGE is read before anything is answered: ``attach`` (which
returns at once for a process that has exited or is idle) must say ``DONE``, its verdict for a turn
that ended in ``turn.completed`` past the worker's turn offset, or for a Claude worker ``IDLE``,
its turn's reply to the latest message sent. A Claude worker's status line is read further, and
whatever it does not show is the next tick's, recorded nowhere: a line with no numeric
``results=`` names no turn; an ``IDLE`` line whose ``unread=`` is not 0 shows a message the CLI has
not echoed (an answer, or the coordinator's, on its way), so the idle turn is not that message's
reply, and one whose ``turn=`` is not ``ended`` or whose ``background_tasks=`` is not 0 shows a
turn that began after the far side read the state. THE RE-READ: once the message is read, ``status`` is read again, and the turn is answered
only when the session and the count are unchanged and the state is still a returned one. The
count only grows, so an unchanged count proves the message read was the n-th result's; a turn the
worker began on its own meanwhile (a ``ScheduleWakeup``) leaves the reading to the next tick. A
TURN THAT DIED: a Claude worker that is ``EXITED``, ``VANISHED`` or ``UNKNOWN`` while its count's
turn was ``answered`` took the answer and ended no turn since, which no count would ever show:
attention, once. ``ORPHANED`` is told the same way, its CLI outliving its tmux session (it may
still run that turn, and ``unstick --kill`` resumes it). A REVIEW OUTRUN: a Claude worker whose count moved past a turn whose
review still runs (a turn it began on its own meanwhile) has the newer turn's message read under
THE RE-READ, kept in its ``msgs/`` file and named in an attention line, once, before the review is
collected as before: the review's answer is sent, and two answers are not raced. Only then is the
final message read with ``log --last-result``, saved to ``msgs/<task>.<worker>.<session>.<turn>.md``
(every file of a turn is named by the turn's whole identity), and classified by
THE MARKERS. ``log --last-result`` alone would not do: it skips a turn that never completed and
prints the message of the turn before it, so a resumed worker that died at startup would be
answered with its previous handoff again. A verdict other than ``DONE`` (``FAILED``: killed, no
terminal event, a failed turn), the states ``ORPHANED``, ``VANISHED`` and ``UNKNOWN``, and a turn
with no final message are attention. A box that does not answer, and a status line this driver cannot read, are tried again
next tick and recorded nowhere: only a state the worker is really in ends a turn's reading.

THE MARKERS, a fail-closed allowlist over the final message's non-blank lines. The closed list
of block forms excluded from marker reading is: explicit `>`-prefixed lines, backtick fences and
tilde fences, each with up to three leading spaces. A fence opens with at least three matching
characters and optional info (without backticks for a backtick fence), and ends at a fence of
the same character and at least the opening length with only trailing whitespace, or at EOF.
List-relative and indented code, lazy quote continuations, inline spans and HTML get no special
handling. The first and last positions still refer to the original message. Exactly one of these
forms holds, or the turn goes to the re-prompt or attention path:
  windows   a line that is exactly ``WINDOWS_WITNESS_REQUEST`` (coordinator attention,
            never assigned; its payload is kept verbatim, not parsed or executed)
  request   a line that is exactly ``EXECUTION_REQUEST``
  result    one or more lines ``EXECUTION_RESULT {json}``, and no line that starts with
            ``EXECUTION_RESULT`` and is not that, whole (a wrapped, space-separated or cut result is
            never dropped beside a good one: the turn is attention, naming the expected JSON form)
  review    the last line is ``REVIEW_REQUEST <pr> <40-hex sha>``
  confirm   the last line is ``CONFIRM_REQUEST <pr> <40-hex sha>``
  handback  the first line starts with ``HANDBACK``
Two of them in one message (including a later ``HANDBACK`` line beside another marker or an earlier
``REVIEW_REQUEST``/``CONFIRM_REQUEST``) is attention. Unrecognised messages are named by the last
line's first word. A paired worker's PLAN ENVELOPE is read first: a
message with a line that is exactly ``PLAN_READY`` and a later one exactly ``END_PLAN_READY`` is
attention as a plan, whatever lines it holds, since a plan's Verification section may quote a
marker (an ``EXECUTION_REQUEST`` example) that is no request.

  re-prompt a Gemini final with no recognised or misplaced marker gets one automatic request
            to resend, per worker session. Explicit coordinator handoffs (``NEEDS_DESIGN``,
            ``PENDING``, ``EXECUTION_REBIND``) and malformed markers still go to attention. The driver
            persists the attempt before calling unstick. If interrupted before it records an
            outcome and the same turn is still returned, it raises attention for reconciliation.
            A later marker-less final in that session goes to attention.

THE ANSWERS:
  windows   attention immediately, once per returned turn, naming the saved request. The
            coordinator follows executions.md, Bounded native Windows verification.
  request   ``execution assign <reserve/<task>-base.json> <message> --message <file> --unstick <box>
            <worker> --status <file>``: it reserves, dispatches and resumes in one call, and its
            input omits the excluded blocks above while the saved final remains whole. Its
            status file (assign.py, THE STATUS; removed before the call, unread when that removal
            fails, and read only when its ``exit`` is the call's) says what its unstick did.
            Exit ``LEASE_LOST_STATUS`` (6) ends the driver. All lease-gated verbs now report loss
            by status (#1259), retiring the lease-refusal regex for diagnostics and review logs.
            A block an earlier call dispatched (assign's ``ASSIGN ALREADY`` line: a driver that died
            before it resumed the worker) is not assigned again, so its text is not in this call's message. Exit 0
            with no message printed means every block was such: the worker is resumed with that
            call's saved message, and where none was saved the turn is attention. Exit 0 with a
            message and such a block beside it has resumed the worker with part of its
            assignments, which is attention at once. Exit 1 with no message is tried again each
            ``RETRY`` seconds, ``TRIES`` times, then attention (for example, a full box or pending
            window). The closed list of incurable refusals is assign usage (exit 2), and the
            following cases reported by assign as exit 5:
            - run/window usage
            - rejected revision checks (invalid revision or repository, an absent commit, a
              missing or unreadable-by-this-token ``head-of:`` branch returning 404, or a
              successful GitHub response that does not match the requested commit or name a head)
            - invalid request fields, issue or request id, including an id collision by case
            - a host outside the exact fleet roster, an empty or aliased roster, an unreadable
              or invalid configured endpoint map, an invalid correctness slot spec, an anchor
              without the required lab lock configuration, or an outstanding record on a host
              no longer in the roster
            - a reserved id whose assignment or window definition differs, or whose reservation
              was adopted and needs reconciliation.
            The code sources are ``registry.AssignmentInput``, ``execution.cmd_execution`` (the
            endpoint map and revision refusals through ``execution.fail(..., refusal_status=...)``),
            and assign's usage exits.
            Only assign's status classifies these refusals. Exit 1 or 5 with assignments in the
            message has resumed the worker with those, so it is attention at once for the
            unassigned blocks. Do not replay the assigned blocks. Exit 5 with no message is
            attention at once. Its note copies the final line of assign's stderr only when
            framed by ``ASSIGN ACTION REQUIRED ``. Earlier stderr lines, stdout and the worker's
            request text supply no detail to that note.
            Other nonzero exits are also attention (exit 4 can require reconciliation before
            any further assignment); exit 4's line says whether the worker was resumed, which is
            exactly when the status's ``unstick`` is ``landed`` (an UNKNOWN beside an assignment),
            and otherwise names the status's outcome: ``failed`` (``ASSIGN UNSTICK FAILED``) or an
            unreadable status (missing, malformed, another call's, or one left that could not be
            removed first) beside a printed message is not known to have landed, so the worker's state is reconciled before
            any resend; ``message-unwritten`` and the other outcomes ran no unstick.
            Every answer ends with the status's ``tally`` lines, the unstick's own ``BOARD TALLY``
            lines (assign ran it: the answered note, the mixed-``ALREADY`` and partial-assignment
            attention, and an exit 4 beside a message), so a lost count is never silent; an answer
            whose assign ran no unstick carries none. The boundary: only the status file is read
            for these, never assign's stderr, so a step's echoed ``BOARD TALLY WARNING`` adds
            nothing; an answer whose assign printed a message and left no readable status says
            that instead, since its count is then unread.
  result    each line needs ``request_id``, an absolute ``run`` and a 40-hex ``observed_sha``, and is
            concluded off the run record: ``execution conclude --from-run``, and when that refuses,
            ``--from-bg-run`` (a refused conclusion concludes nothing, so trying both reads is
            safe). The worker is resumed with one ``EXECUTION_CONCLUDED <id> <verdict>`` line per
            result. A line that cannot be read or concluded is attention, and the worker waits.
  review,   ``wave review ... --kind at-open|confirm`` as a ``bg-run.sh spawn`` under
  confirm   ``logs/drive-runs`` (a review takes minutes, and the driver serves the other workers
            meanwhile); the ledger keeps the run directory, and a later tick reads it with
            ``bg-run.sh wait``. Finished with exit 0, its line names the message file the worker is
            resumed with; ``decision=unreadable`` is attention besides (the worker is resumed, the
            review is the coordinator's to read). Exit 6 marks the round interrupted and stops
            the driver. On restart the same round runs without ``--again``, recovering its saved reply
            if already posted. Every other unsuccessful end is attention. ``--again`` is passed
            when the ledger holds an answered review of the same PR, kind and head in an earlier
            turn: a new request from the worker is a new round (wavereview.py).
  handback  the PR is the row's ``pr``, else the first ``/pull/<n>`` outside the excluded blocks. The message
            is saved as ``handbacks/<task>.md`` and the task closed with ``board close``, which
            verifies the merge on GitHub itself. Without a PR, each exact ``RUN /absolute/path``
            line supplies a repeated ``--run`` to ``board close --no-pr``; no such line is attention.
            Trailing whitespace on the line (``str.rstrip()``: Markdown two-space line breaks, tabs,
            ``\r``) is trimmed; internal spaces stay, paths consume the rest of the line with no
            quoting, backslash stripping or prose, and leading whitespace, extra space after
            ``RUN``, bare ``/`` and relative paths are not read. A close that refuses is attention.
            So is a merge that THE CONFIRM does not cover: the coordinator is told, and then the
            row closes (in that order: a closed row is served no more).

THE CONFIRM, read off ``wave review``'s records of the PR that were posted (a record with no
comment, a dry run's, is no review), the rounds ``--again`` set aside included (``<stem>.r<n>.json``:
their comments stay on the PR): when the newest at-open review blocks (``confirm`` or
``unreadable``), a merge is covered only when the newest confirm made after that review is
``cleared``, at the head the PR merged at (``gh pr view --json headRefOid``). A clearance of an
earlier head, one older than the blocking review, one a later confirm round took back (``findings``
after ``cleared``, at the same head or another), and a head GitHub does not answer for are all
not covered.

ATTENTION is a line appended to ``<wave dir>/logs/attention.jsonl`` and printed as ``DRIVE ATTENTION
<task> turn <n>: <why> (<file>)``, written before the turn is made final in the ledger: a driver
killed between the two tells the coordinator again on its restart (the turn is read again), and
never leaves a final turn nobody was told of. The driver goes on serving the other workers; ``wave heartbeat``
prints the new attention lines and returns early when one arrives, so it stays the coordinator's
one wake source. An attention turn is final: the coordinator answers it by hand, and the worker's
next turn is a new turn.

THE QUEUE, ``<wave dir>/queue.json``, is the launches the coordinator decided and left to the driver:

    {"capacity": {"<box>": <n>, ...},
     "tasks": [{"task", "profile", "host"[, "legs": [<box>, ...]][, "mode"][, "after": [<task>, ...]]
                [, "issue" | "source"][, "tier"][, "reassignment_reason"]}, ...]}

A fail-closed allowlist, read each tick (the coordinator may add tasks while the driver runs): any
other key, a task named twice, a profile that is no profile of the wave file, a CLI entry's host with
no ``capacity``, a ``tier`` that is no tier of ``wave prep --tier`` (waveprep.py's THE TIER),
a ``reassignment_reason`` that is no nonblank single line of printable text, an
``after`` that is no task id, or one that names the task itself or a task
queued LATER (the file's order is the launch order, so no two queued tasks can wait on each other)
refuses the whole file, said once as ``DRIVE QUEUE REFUSED`` and launching nothing until it reads.
Said once, it is also an attention record, task ``queue.json`` (the turn ``launch``), so the
heartbeat's sleep ends on it: a refused file holds every queued launch, and a record nobody wakes
for was read only at the next full tick (wave-20261115-ludics: ten minutes). It is no ledger line
and makes nothing final; a corrected file is read on the next tick, and a different refusal is
told again. Like the gate's, its "once" is this process's (#1130's fourth item).
So does a wave file with no ``vars.MAIN``, the branch a queued task is prepared at. An ``after``
task that is not queued needs no row yet: it may be a native task the coordinator has still to
launch. With no file the driver launches nothing.
A NATIVE ENTRY is one whose worker is not a CLI worker: it names a profile whose ``transport`` is not
``cli``, or it names no profile and the wave file's own ``transport`` is not ``cli`` (a wave whose
native workers are its default worker has no native profile to name). It takes ``task`` and
optionally ``profile``, ``after`` and ``tier``, and no other key: the driver prepares nothing for it, so
prep's flags are the coordinator's (its cue names ``--tier <tier>`` when the entry has one). The driver never refreshes, prepares, un-prepares or launches
it and counts it against no capacity; when it is due (as below, but for the capacity, the backoff
and the prepared record: no row or a ``pending`` one, every ``after`` row landed, not halted, THE
GATE open) it CUES it: one attention line, ``<task> is due: launch it``, then a ledger line
``cued`` (told first and recorded after, as ``attention`` does). A task with a ``cued`` line is
never cued again, so a restarted driver does not repeat it; ``cued`` is no final status, so no
reader takes it for a launch decision, and it holds no slot. A cue starts nothing, so it takes
no tick's launch: the scan goes on past it. A native row past ``pending`` (the coordinator
launched it, cue or no cue) is not cued; a CLI task ``after`` a native entry waits on its row.
After the workers' turns, each tick takes the FIRST CLI task in file order that is due and starts
it, one a tick (THE GATE and the halt are read once a tick, for the cues and the start alike):
  due       no row yet, or a ``pending`` row (prepared, its launch refused so far); every ``after``
            task's row ``merged`` or ``done``; fewer CLI rows of this wave holding a slot on its
            host (``slots_held``: any kind, past ``pending`` and not done) than the host's
            capacity; no final ``launch`` line in the ledger; launches not halted (``halted``,
            read once a tick: a halt is waited out, silently); THE GATE open
  started   with no row, ``refresh <agent host>`` (THE REFRESH), then ``wave prep <task> --base
            <origin/MAIN, fetched now> --profile ... [--host] [--legs] [--mode] [--issue|--source]
            [--tier] [--reassignment-reason]``
            (a dependent starts from the base its prerequisite merged into), then ``wave launch``
            Prep's split NOTE is passed through on stderr, with no change to the launch decision.
            A stale pending row with a reassignment reason and no reason in the queue is left to the
            coordinator before unprep can remove the row. A fenced unprep is already in progress.
A PAIRED LAUNCH, of an entry whose ``mode`` is not ``none``, is told once its launch answers: one
non-final attention line, ``launched <mode> at <sha>: start its peer planner on that sha``. The
notice gives the coordinator the board target flags for ``peer-plan.sh start``. Both plans must
read one tree, so the coordinator starts the planner on that sha.
THE REFRESH: ``wave prep`` runs from the agent host's served skills checkout, and the project part
it renders is read at the fetched tip, so a checkout one merge behind can lack a built-in that part
names (a ``WAVE PREP REFUSED`` wave-20261113b-ludics saw). ``refresh`` brings it to its origin, or
says why not, and resets nothing; its exit never stops a prep, and when the prep then refuses, the
refresh's line is beside the prep's in that attention.
When otherwise due, a task waiting only on ``after`` tasks with neither rows nor queue entries
is told through a non-final attention line naming those tasks; it still starts (a native entry:
is still cued) when they merge.
The last missing-task list told for each task is kept in memory (as the queue's and gate's
refusals are): an unchanged list is said once, an empty list clears it, and a restarted driver
tells it again. A task also
waiting on capacity, a halt, THE GATE or a prerequisite with a row or queue entry stays silent.
THE GATE is the launch gate, ``gate --target-repo <repository> --base-branch <MAIN>``, read BEFORE
a task is prepared, with ``--no-wait``: a single checker read, no base observer held and no
polling pause. Pending (exit 4) is read again next tick, without a retry backoff. After 600 seconds of
pending snapshots at the same observed remote tip (or continuously unreadable tip samples),
one non-final attention line wakes the
heartbeat; it admits nothing and changes no retry. The timer and told-once are in memory:
a verdict (any non-4 exit), a changed tip sample (including readable↔unreadable), or a driver
restart resets both. Repeated unreadable samples do not reset the interval. Exit 4 also covers
an unanswered anchor; the notice names both possible causes. Only pending reads sample ``git ls-remote origin refs/heads/<MAIN>`` (10 s timeout);
this diagnostic sample observes changes between ticks, not moves away and back between reads,
and is never an admission proof. A tick with no gate read leaves the sample unchanged; elapsed wall time includes those gaps;
the coordinator's waiting gate keeps its one observer. VERDICT FILE BOUNDARY: no saved gate verdict is accepted, for any SHA, age or writer.
Every admission comes from this invocation's checker read of the branch, under gate.py's policy;
logs and foreign or stale verdict files admit nothing. A launch needs the branch's tip to be the prepared base, and a prep is not
done twice, so a task prepared under a red base would be stale the moment the fix merged. While the
gate refuses, nothing is prepared or launched. For other refusals, the coordinator is told once
for each refusal it
has not been told (kept in memory: a restarted driver tells it again), and the gate is read again
after ``RETRY`` seconds.
A PREPARED task (a ``pending`` row) is launched where and at what its prep recorded, the manifest's
launch record (wavelaunch.py), never the queue's entry: an entry that names another host than the
record's is attention, final, and leaves the task to the coordinator. A STALE PREPARED TASK, one
whose record's base is no longer the branch's tip (prepared, its launch refused or not yet made,
and the branch moved), is un-prepared with ``wave unprep`` (waveunprep.py, under its own refusals:
a launch on record, a ledger line holding a slot, a reservation of its standing ids, a row that
is not its prep's pending row): exit 0 is a non-final ledger line ``unprepared`` and the
coordinator told once, and with no row left the task is due again, prepared at the tip under its
own id on a later tick; exit 4 is the next tick's; any other exit is attention, final, with the
verb's line. A task whose manifest ends with the verb's fence (an un-prepare that stopped, with
its row removed or not) is un-prepared again the same way before anything else, never sent to a
prep or a launch that would refuse on that manifest.
A task whose ``after`` task's row ended without a merge (``closed``, ``dropped``) can never come
due: that is attention, final, since nothing else would say the task is not going to start.
A prep that refuses (a rival PR, a branch that exists, a missing task part) is attention, final:
the coordinator launches that task by hand. A launch its own gates refuse started no worker and
may clear: ``LAUNCH REFUSED`` as its last line (a preflight, a halt) or the base gate's ``BASE
REFUSED:`` on its stderr (a base that turned red after THE GATE read it), with exit 1. It is told
once and tried again each ``RETRY`` seconds, while its base is still the branch's tip. Any other
end of ``wave launch`` (its own refusal, exit 3 with a NOTE, exit 4) is attention, final.
A SLOT HELD: such an end may have started a worker whose row still says ``pending`` (exit 3 with
the row not set, exit 4 with the reservation dispatched), so it holds a slot on the task's host
until the row leaves ``pending`` (the coordinator set it ``launched``, where the row itself then
counts, or closed it). Only ``WAVE LAUNCH REFUSED``, the verb's own reads refusing before it
starts anything, holds none. The launch is written to the ledger (``launching``, carrying a fresh
``launch_id`` matching ``boardstore.LAUNCH_ID`` — each ``wave launch`` invocation, including a retry
after a pre-start refusal, gets its own attempt number so a status file from an earlier invocation
can never match a later one) before it is made: a driver that stops inside one
leaves that line, and the next driver makes it attention, final, holding the slot, since it cannot
know how the launch ended. The driver passes ``--status <file> --launch-id <id>`` to ``wave launch``
(wavelaunch.py, THE STATUS; ludics#1290). On a lost lease (exit 6), the driver reads only that status
file fail-closed (matching exit, wave, task, host and ``launch_id``), never stdout/stderr prose:
only when ``wave launch`` explicitly states ``outcome == "pre-start"`` does the driver record a
non-final ``lease-lost`` line without ``holds`` (releasing the slot hold so the next tick can launch
on that host) before stopping; a post-start loss (``started``), a post-reservation loss
(``reserved``), or a missing/malformed/mismatched status keeps the ``launching`` hold as before. An anchor, a remote or GitHub that does not answer is the next tick's.

WHAT IT DOES NOT DO. It scopes nothing and orders nothing (the queue is the coordinator's), reads
no hand-back's proposals (the editorial pass is the
coordinator's, at close-out, over ``handbacks/``), and decides nothing a marker does not state.
The driver requests ``--lease-status`` for unstick, execution conclude, board close, gate and
wave prep/unprep/launch/review. A review's completed command status comes from bg-run. Assign
reports a lost lease itself.

It stops on a stop file (``<wave dir>/drive.stop``, read before each tick) with exit 0, on a board
it cannot read as this wave's (exit 1; an anchor that does not answer is tried again), and on a
lost lease. ``--once`` runs one tick. Exit 2 is usage.
"""

import glob
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, replace
from typing import Any, cast

from ludics import bgrun, cli
from ludics.fleetworker.assign import ACTION_REQUIRED_LINE
from ludics.fleetworker.boardstore import LAUNCH_ID
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import LEASE_LOST_STATUS
from ludics.fleetworker.registry import ASSIGN_ACTION_REQUIRED
from ludics.fleetworker.takeover import DONE_STATES, board_document, state_word
from ludics.fleetworker.tally import said, suffix
from ludics.fleetworker.transport import Done, substitution
from ludics.fleetworker.wave import USAGE, WORD, Wave, acquire_startup_lock, load_wave, shim, utc_now
from ludics.fleetworker.wavebrief import write_atomically
from ludics.fleetworker.wavelaunch import Record, read_manifest, read_wave_launch_status
from ludics.fleetworker.waveprep import REASSIGNMENT_REASON_PROBLEM, TASK, TIERS, Stop, valid_reassignment_reason
from ludics.fleetworker.waveunprep import FENCE

sleep: Callable[[float], None] = time.sleep  # the tests' seam, as waveloop's
now: Callable[[], float] = time.time


def execute(argv: Sequence[str], timeout: float | None = None) -> tuple[int, str, str]:
    """A command's status, stdout and stderr (the tests' seam for every command the driver runs). Its
    stderr is passed on to ours, so a verb's own lines stay in the driver's output. With ``timeout``
    (seconds), a command still running then is killed and completes 124, timeout(1)'s status."""
    try:
        done = subprocess.run(list(argv), capture_output=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]}: no answer in {timeout}s\n"
    except OSError as exc:
        return 127, "", f"{argv[0]}: {exc.strerror}\n"
    err = done.stderr.decode("utf-8", "replace")
    # Flushed at once, our stdout first: a stream that carries both (a ``bg-run.sh`` log, a ``2>&1``)
    # then reads in write order, the verb's own lines above the driver's line about them. The
    # package's stderr is block-buffered (cli.setup_streams), which put every DRIVE line first.
    sys.stdout.flush()
    sys.stderr.write(err)
    sys.stderr.flush()
    return done.returncode, done.stdout.decode("utf-8", "replace"), err

POLL = 30
ATTACH_WAIT = 60.0  # attach answers at once for an exited worker; one that started running since is left for the next tick
RETRY, TRIES = 300, 6
FINAL = ("answered", "attention")
OPEN_REVIEW = ("reviewing", "review-interrupted")
RETURNED = re.compile(r"(EXITED\([0-9]+\)|IDLE)")
GONE = ("ORPHANED", "VANISHED", "UNKNOWN")  # states that are no returned turn and will not become one
WORKING = "RUNNING"  # the worker's state while its turn runs (farside.py's state_of), not bg-run.sh's verdict word
STATUS = re.compile(r"(\S+) \S+/\S+ .*?\bsession=(\S*) .*\bresumes=([0-9]*)(?: results=(\S+))?")
# A stream worker's turn state, listed background tasks and messages not yet echoed (farside.STATUS).
CHANNEL = re.compile(r"\| turn=(\S+) background_tasks=(\S+) unread=([0-9]+) \|")
SERVED = ("codex", "claude", "gemini")
ASK = re.compile(r"(REVIEW|CONFIRM)_REQUEST #?([1-9][0-9]*) ([0-9a-f]{40})")
RESULT = re.compile(r"EXECUTION_RESULT (\{.*\})")
# Canonical line-leading marker tokens of THE MARKERS; farside.LOG_LAST_RESULT pins the same tuple.
MARKER_TOKENS = (
    "PLAN_READY", "END_PLAN_READY", "WINDOWS_WITNESS_REQUEST",
    "EXECUTION_REQUEST", "EXECUTION_RESULT", "REVIEW_REQUEST", "CONFIRM_REQUEST", "HANDBACK",
)
COORDINATOR_TOKENS = ("NEEDS_DESIGN", "PENDING", "EXECUTION_REBIND")
MARKER_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})(.*)")
MARKER_QUOTE = re.compile(r" {0,3}>")
PULL = re.compile(r"/pull/([1-9][0-9]*)")
SHA40 = re.compile(r"[0-9a-f]{40}")
REF = re.compile(r"[^#\s]+#([1-9][0-9]*)")
REVIEWED = re.compile(r"WAVE REVIEW \S+: .* decision=([a-z]+) comment=\S+ message=(.+?\.message\.md)(?: \(already reviewed.*)?")
ALREADY = re.compile(r"ASSIGN ALREADY (\S+):")


def append_line(path: str, record: dict[str, Any]) -> None:
    """One JSON record appended as a whole line, fsynced. A file whose last write was cut (a driver
    killed mid-line: no final newline) gets its newline first, so the torn piece stays a line of its
    own, which every reader skips, and never swallows the record appended after it."""
    with open(path, "a+b") as f:
        f.seek(0, os.SEEK_END)
        if f.tell() > 0:
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                f.write(b"\n")
        f.write((json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8"))
        f.flush()
        os.fsync(f.fileno())


LAUNCH = -1  # the ledger's turn for a queued task's launch, which is no worker's turn
LANDED = ("merged", "done")  # the row states of an ``after`` task that let its dependents start
# A launch its own gates refused before anything started, which may clear (THE QUEUE): the launch
# verb's refusal as stdout's last line, or the base gate's, which it writes to stderr.
PRESTART = re.compile(r"^(?:LAUNCH REFUSED |BASE REFUSED: ).*$", re.M)
QUEUE_KEYS, QUEUED_REQUIRED = ("capacity", "tasks"), ("task", "profile", "host")
QUEUED_OPTIONAL = ("legs", "mode", "after", "issue", "source", "tier", "reassignment_reason")
NATIVE_KEYS = ("profile", "after", "tier")  # a native entry's keys beside ``task`` (A NATIVE ENTRY, the header)
CUED = "cued"  # a native entry's ledger status once its cue was told: never told again, and no launch decision


@dataclass(frozen=True)
class Queued:
    task: str
    profile: str
    host: str
    legs: tuple[str, ...]
    mode: str
    after: tuple[str, ...]
    issue: str
    source: str
    native: bool = False  # A NATIVE ENTRY (the header): cued, never prepared or launched
    tier: str = ""  # wave prep's --tier (waveprep.py's THE TIER); "" when the entry names none
    reassignment_reason: str = ""


def launch_attempt_id(wave_name: str, task: str, attempt: int) -> str:
    """One launch-attempt identity in ``boardstore.LAUNCH_ID``'s recipe: ``<wave>-<task-slug>-<n>``."""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", task).strip("-") or "task"
    candidate = f"{wave_name}-{slug}-{attempt}"
    assert LAUNCH_ID.fullmatch(candidate), candidate
    return candidate


def label(turn: int) -> str:
    return "launch" if turn == LAUNCH else f"turn {turn}"


def read_queue(wave: Wave) -> tuple[dict[str, int], list[Queued]] | str | None:
    """THE QUEUE (the header): the capacities and the tasks, None with no file, or why it is refused."""
    path = os.path.join(wave.directory, "queue.json")
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        return f"{path} is not readable JSON ({exc})"
    if not isinstance(data, dict) or set(cast(dict[str, Any], data)) - set(QUEUE_KEYS):
        return f"{path} is one object with the keys {', '.join(QUEUE_KEYS)} and no other"
    top = cast(dict[str, Any], data)
    raw_capacity: Any = top.get("capacity", {})
    raw_tasks: Any = top.get("tasks", [])
    if not isinstance(raw_capacity, dict) or not isinstance(raw_tasks, list):
        return f"{path}: capacity is an object of <box>: <n>, and tasks a list"
    capacity: dict[str, int] = {}
    for box, n in cast(dict[str, Any], raw_capacity).items():
        if not WORD.fullmatch(box) or not isinstance(n, int) or isinstance(n, bool) or n < 1:
            return f"{path}: capacity.{box} must be a whole number of workers, at least 1"
        capacity[box] = n
    tasks: list[Queued] = []
    later: set[str] = set()  # the tasks an entry so far comes after: none of them may be queued from here on, or be the entry
    for entry in cast(list[Any], raw_tasks):
        if not isinstance(entry, dict):
            return f"{path}: a task is an object"
        item = cast(dict[str, Any], entry)
        name = item.get("task")
        what = f"{path}: task {json.dumps(name)}"
        # A NATIVE ENTRY (the header): its worker's transport, its profile's or with none the wave's own, is not cli.
        named: Any = item.get("profile")
        native = (wave.transport != "cli" if "profile" not in item
                  else isinstance(named, str) and named in wave.profiles and wave.profiles[named].transport != "cli")
        if native:
            if set(item) - {"task", *NATIVE_KEYS} or "task" not in item:
                return (f"{what} is a native entry, which takes task and optionally {', '.join(NATIVE_KEYS)}: the driver prepares"
                        " nothing for it, so prep's flags are yours when you launch it")
        elif set(item) - set(QUEUED_REQUIRED) - set(QUEUED_OPTIONAL) or any(key not in item for key in QUEUED_REQUIRED):
            return f"{what} takes {', '.join(QUEUED_REQUIRED)} and optionally {', '.join(QUEUED_OPTIONAL)}"
        lists = {key: item.get(key, []) for key in ("legs", "after")}
        texts = {key: item.get(key, "") for key in ("task", "profile", "host", "mode", "issue", "source", "tier", "reassignment_reason")}
        if not all(isinstance(v, str) for v in texts.values()) or not all(
                isinstance(v, list) and all(isinstance(x, str) and x for x in cast(list[Any], v)) for v in lists.values()):
            return f"{what}: its values are text, and legs and after lists of text"
        if not TASK.fullmatch(texts["task"]) or any(q.task == texts["task"] for q in tasks):
            return f"{what} is no task id ({TASK.pattern}), or is queued twice"
        chosen = wave.profiles.get(texts["profile"])
        if native:
            pass  # no host, so no capacity: the driver only cues it
        elif chosen is None:
            return (f"{what}: profile {texts['profile']!r} is no profile of the wave file (a cli profile's task is launched,"
                    " a native one's cued)")
        elif texts["host"] not in capacity:
            return f"{what}: host {texts['host']!r} has no capacity"
        if texts["issue"] and texts["source"]:
            return f"{what} names both an issue and a source"
        if "tier" in item and texts["tier"] not in TIERS:
            return f"{what}: tier is one of {', '.join(TIERS)}, not {texts['tier']!r}"
        if "reassignment_reason" in item and not valid_reassignment_reason(texts["reassignment_reason"]):
            return f"{what}: reassignment_reason {REASSIGNMENT_REASON_PROBLEM}"
        if any(not TASK.fullmatch(dep) for dep in cast(list[str], lists["after"])):
            return f"{what}: after takes task ids ({TASK.pattern})"
        later.update(cast(list[str], lists["after"]))
        if texts["task"] in later:
            return (f"{what} comes after itself, or is queued after a task that waits on it: the file's order is the launch"
                    " order, so a task's queued prerequisites are above it")
        tasks.append(Queued(texts["task"], texts["profile"], texts["host"], tuple(cast(list[str], lists["legs"])), texts["mode"],
                            tuple(cast(list[str], lists["after"])), texts["issue"], texts["source"], native, texts["tier"],
                            texts["reassignment_reason"]))
    return capacity, tasks


class LeaseLost(Exception):
    """A gated verb reported an absent or foreign coordinator lease."""


UNSTICK_OUTCOMES = ("landed", "failed", "not-asked", "nothing-assigned", "message-unwritten", "lease-lost")


def assign_status(path: str, rc: int) -> dict[str, Any] | None:
    """``execution assign``'s status file (assign.py, THE STATUS), read fail-closed: None unless it is
    one object of its four fields, its ``exit`` this call's status, its ``unstick`` a known outcome,
    its ``tally`` single lines and its ``lease_lost`` a single line."""
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    status = cast(dict[str, Any], data)
    tally: Any = status.get("tally")
    lines = cast(list[Any], tally) if isinstance(tally, list) else None
    lost: Any = status.get("lease_lost")
    if (set(status) != {"exit", "unstick", "tally", "lease_lost"} or type(status["exit"]) is not int or status["exit"] != rc
            or status["unstick"] not in UNSTICK_OUTCOMES or lines is None
            or not all(isinstance(line, str) and line and "\n" not in line for line in lines)
            or not isinstance(lost, str) or "\n" in lost):
        return None
    return status


@dataclass(frozen=True)
class Worker:
    task: str
    name: str
    box: str
    fields: dict[str, str]
    session: str = ""  # status's session= (a Codex thread id, a Claude session id), read each tick: part of a turn's identity
    count: str = "resumes"  # the status field that numbers its turns (A TURN): ``results`` for a Claude worker


@dataclass(frozen=True)
class Turn:
    kind: str  # windows, request, result, review, confirm, handback, or other
    why: str = ""  # other: what the turn is, for the attention line
    pr: str = ""
    sha: str = ""
    results: tuple[str, ...] = ()
    markerless: bool = False
    request_text: str = ""  # the assign input when it differs from the saved final


def marker_lines(message: str) -> Iterator[str | None]:
    """THE MARKERS (the header). Keep line positions when excluding a block."""
    fence = ""
    for line in message.split("\n"):
        boundary = MARKER_FENCE.fullmatch(line)
        if fence:
            if boundary and boundary[1].startswith(fence) and not boundary[2].strip(" \t\r"):
                fence = ""
            yield None
        elif boundary and (boundary[1][0] == "~" or "`" not in boundary[2]):
            fence = boundary[1]
            yield None
        elif MARKER_QUOTE.match(line):
            yield None
        else:
            yield line


def classify(message: str) -> Turn:
    """THE MARKERS (the header)."""
    original = [line for line in message.split("\n") if line.strip()]
    if not original:
        return Turn("other", "an empty final message")
    marked = list(marker_lines(message))
    positioned = [line.strip() if line is not None else None for line in marked]
    positioned = [line for line in positioned if line != ""]
    lines = [line for line in positioned if line is not None]
    if "PLAN_READY" in lines and "END_PLAN_READY" in lines[lines.index("PLAN_READY"):]:
        return Turn("other", "a PLAN_READY plan, the coordinator's (paired-planning.md)")
    found: list[Turn] = []
    if "WINDOWS_WITNESS_REQUEST" in lines:
        found.append(Turn("windows"))
    if "EXECUTION_REQUEST" in lines:
        request_text = "\n".join(line or "" for line in marked) if None in marked else ""
        found.append(Turn("request", request_text=request_text))
    claimed = [line for line in lines if line.startswith("EXECUTION_RESULT")]
    results = tuple(m.group(1) for m in (RESULT.fullmatch(line) for line in claimed) if m)
    if len(results) != len(claimed):
        # One result read and another dropped would conclude part of a turn and resume the worker.
        return Turn(
            "other",
            'an EXECUTION_RESULT line that is not `EXECUTION_RESULT {"request_id":"...","run":"/abs/path","exit":0,"observed_sha":"<40-hex>"}` whole on its own line',
        )
    if results:
        found.append(Turn("result", results=results))
    ask = ASK.fullmatch(positioned[-1] or "")
    if ask:
        found.append(Turn("review" if ask.group(1) == "REVIEW" else "confirm", pr=ask.group(2), sha=ask.group(3)))
    if (positioned[0] or "").startswith("HANDBACK"):
        pull = PULL.search("\n".join(lines))
        found.append(Turn("handback", pr=pull.group(1) if pull else ""))
    elif any(line.startswith("HANDBACK") for line in lines):
        # A later HANDBACK beside another marker (including an earlier REVIEW/CONFIRM_REQUEST)
        # must never let the other marker execute alone (#1308).
        earlier = list(dict.fromkeys([
            *(t.kind for t in found),
            *("review" if m.group(1) == "REVIEW" else "confirm"
              for m in (ASK.fullmatch(line or "") for line in positioned[:-1]) if m),
        ]))
        if earlier:
            return Turn("other", "a final message with more than one marker: " + ", ".join([*earlier, "handback"]))
    if len(found) == 1:
        return found[0]
    if found:
        return Turn("other", "a final message with more than one marker: " + ", ".join(t.kind for t in found))
    return Turn("other", f"no marker this driver answers; the last line starts {original[-1].split()[0][:40]!r}",
                markerless=not any(line.startswith(MARKER_TOKENS + COORDINATOR_TOKENS) for line in lines))


def rows_of(doc: dict[str, Any]) -> list[tuple[str, dict[str, str]]]:
    """The board's rows as (task, fields), a row with no fields object left out."""
    out: list[tuple[str, dict[str, str]]] = []
    tasks: Any = doc.get("tasks")
    for row in cast(list[Any], tasks) if isinstance(tasks, list) else []:
        raw: Any = cast(dict[str, Any], row).get("fields") if isinstance(row, dict) else None
        if isinstance(raw, dict):
            out.append((str(cast(dict[str, Any], row).get("task")), {str(k): str(v) for k, v in cast(dict[Any, Any], raw).items()}))
    return out


def workers_of(doc: dict[str, Any]) -> list[Worker]:
    """WHO IT SERVES (the header)."""
    out: list[Worker] = []
    for task, fields in rows_of(doc):
        word = state_word(fields.get("state", ""))
        if fields.get("transport") != "cli" or fields.get("kind") not in SERVED or not fields.get("worker") or not fields.get("agent_host"):
            continue
        if word is None or word == "pending" or word in DONE_STATES:
            continue
        out.append(Worker(task, fields["worker"], fields["agent_host"], fields,
                          count="results" if fields.get("kind") == "claude" else "resumes"))
    return out


def slots_held(doc: dict[str, Any]) -> dict[str, int]:
    """THE QUEUE's capacity count: for each host, the wave's CLI rows that hold a slot there. That is
    every CLI row of ANY kind that is not ``pending`` and not done, whether or not this driver answers
    its turns (a row of a kind it does not serve, or with no worker yet, fills a slot too), and a row whose state it cannot read counts:
    an unreadable row frees no slot."""
    held: dict[str, int] = {}
    for _, fields in rows_of(doc):
        word = state_word(fields.get("state", ""))
        if fields.get("transport") == "cli" and fields.get("agent_host") and word != "pending" and word not in DONE_STATES:
            held[fields["agent_host"]] = held.get(fields["agent_host"], 0) + 1
    return held


class Driver:
    def __init__(self, cfg: Config, wave: Wave) -> None:
        self.cfg, self.wave = cfg, wave
        self.script = shim(cfg)
        self.gated_shim = replace(cfg, lease_loss_status=LEASE_LOST_STATUS).shim_command()
        self.ledger_path = self.path("logs", "drive.jsonl")
        self.ledger: list[dict[str, Any]] = []
        self.err = ""  # the last call's stderr
        self.queue_refusal = ""  # the queue's refusal last said, so it is said once
        self.queue_missing: dict[str, tuple[str, ...]] = {}  # each task's missing prerequisites last told
        self.gate_refusal, self.gate_next = "", 0.0  # THE GATE's refusal last told, and when it is read again
        self.gate_pending_tip: str | None = None
        self.gate_pending_since = 0.0
        self.gate_pending_told = False

    def path(self, *parts: str) -> str:
        return os.path.join(self.wave.directory, *parts)

    def turn_file(self, worker: Worker, turn: int, suffix: str) -> str:
        """A file of one turn under ``msgs/``, named by the turn's whole identity (A TURN, the header):
        a worker launched in a task's place never reads, or is resumed with, its predecessor's file."""
        session = re.sub(r"[^A-Za-z0-9._-]", "_", worker.session) or "nosession"
        return self.path("msgs", f"{worker.task}.{worker.name}.{session}.{turn}.{suffix}")

    # --- the ledger and the lines -----------------------------------------------------------------

    def load(self) -> None:
        self.ledger = []
        try:
            with open(self.ledger_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        entry: Any = json.loads(line)
                    except ValueError:
                        continue  # a torn last line: the step is taken again, and each step is a re-read
                    if isinstance(entry, dict):
                        self.ledger.append(cast(dict[str, Any], entry))
        except FileNotFoundError:
            pass

    def last(self, worker: Worker, turn: int) -> dict[str, Any] | None:
        mine = [e for e in self.ledger if e.get("task") == worker.task and e.get("worker") == worker.name
                and e.get("session") == worker.session and e.get("turn") == turn and e.get("count", "resumes") == worker.count]
        return mine[-1] if mine else None

    def note(self, worker: Worker, turn: int, kind: str, status: str, text: str, **more: Any) -> None:
        # A Claude turn's line is tagged with its counter (A TURN): the untagged lines are numbered by resumes.
        tag = {} if worker.count == "resumes" else {"count": worker.count}
        entry = {"at": utc_now(), "task": worker.task, "worker": worker.name, "session": worker.session, "turn": turn,
                 **tag, "kind": kind, "status": status, "note": text, **more}
        append_line(self.ledger_path, entry)
        self.ledger.append(entry)
        if status != "attention":
            self.say(f"DRIVE {worker.task} {label(turn)}: {kind} {status}: {text}")

    def attention(self, worker: Worker, turn: int, kind: str, why: str, file: str = "", **more: Any) -> None:
        """The coordinator is told first, and the turn made final after: a driver that dies between
        the two tells it again on its restart, never not at all."""
        self.tell(worker, turn, why, file)
        self.note(worker, turn, kind, "attention", why, file=file, **more)

    def tell(self, worker: Worker, turn: int, why: str, file: str = "") -> None:
        """The attention line itself, with no ledger entry: what must reach the coordinator before a
        step that would stop this turn from being read again (a resume, a close)."""
        append_line(self.path("logs", "attention.jsonl"), {"at": utc_now(), "task": worker.task, "turn": turn, "why": why, "file": file})
        self.say(f"DRIVE ATTENTION {worker.task} {label(turn)}: {why}" + (f" ({file})" if file else ""))

    def tell_queue(self, why: str) -> None:
        """A refused queue file's attention record (THE QUEUE, the header): the heartbeat wakes on it.
        The ``DRIVE QUEUE REFUSED`` line already said it, so this writes the record alone."""
        append_line(self.path("logs", "attention.jsonl"),
                    {"at": utc_now(), "task": "queue.json", "turn": LAUNCH, "why": why, "file": self.path("queue.json")})

    def say(self, line: str) -> None:
        cli.say(line)
        with open(self.path("logs", "drive.log"), "a", encoding="utf-8") as f:
            f.write(f"{utc_now()} {line}\n")

    def call(self, *args: str, timeout: float | None = None, gated: bool = False) -> Done:
        """Run a fleet verb, requesting the distinct lease status only for gated calls."""
        command = self.gated_shim if gated else [self.script]
        rc, out, self.err = execute([*command, *args], timeout)
        if gated and rc == LEASE_LOST_STATUS:
            cli.emit(substitution(out))
            verb = " ".join(args[:2]) if args[0] in ("board", "execution", "wave") else args[0]
            raise LeaseLost(f"{verb} exit {rc}")
        return Done(rc, out)

    # --- one worker, one tick ---------------------------------------------------------------------

    def reading(self, worker: Worker) -> tuple[str, str, int | None, re.Match[str] | None] | None:
        """One ``status`` read: the state, the session, the turn (None: a status line whose counter this
        driver cannot read) and the line's match; None when the box did not answer."""
        done = self.call("status", worker.box, worker.name)
        if done.rc == 4:
            return None
        line = substitution(done.out).splitlines()[-1] if done.out.strip() else ""
        read = STATUS.match(line)
        state = read.group(1) if read else (done.out.split() or [""])[0]
        if read is None:
            # A line STATUS does not read names no turn; only a gone worker's own line (UNKNOWN: never
            # launched here) is read at turn 0, of no session, for either kind.
            return state, "", 0 if worker.count == "resumes" or state in GONE else None, None
        counter = read.group(4) if worker.count == "results" else (read.group(3) or "0")
        return state, read.group(2), int(counter) if counter is not None and counter.isdigit() else None, read

    def tick(self, worker: Worker) -> None:
        got = self.reading(worker)
        if got is None:
            return  # the box did not answer: next tick
        state, session, turn, read = got
        if state == WORKING or turn is None:
            return  # a running turn, or a Claude status line with no readable results=: next tick
        worker = replace(worker, session=session)
        last = self.last(worker, turn)
        earlier = self.open_review(worker, turn)
        if earlier is not None and RETURNED.fullmatch(state) and (state != "IDLE" or self.replied(read)):
            # A REVIEW OUTRUN (the header): the newer turn's message kept and handed up, then the review collected.
            if last is None or last.get("status") not in FINAL:
                read_log = self.confirmed(worker, turn)
                if read_log is None:
                    return
                kept = self.turn_file(worker, turn, "md") if read_log.rc == 0 else ""
                if kept:
                    write_atomically(kept, read_log.out)
                k = int(earlier["turn"])
                which = label(turn) if turn == k + 1 else f"turns {k + 1} to {turn}"
                self.attention(worker, turn, "turn", f"{which} ended while the review {label(k)} asked for still runs: the review's"
                                                     " answer is still sent; " + (f"{label(turn)}'s message is kept, and is yours" if kept
                                                                                 else f"{label(turn)} has no final message ("
                                                                                 f"{substitution(read_log.out)[-200:]})"), kept)
            return self.collect(worker, int(earlier["turn"]), earlier)
        if (worker.count == "results" and last is not None and last.get("status") == "answered"
                and (state in GONE or state.startswith("EXITED("))):
            # A TURN THAT DIED (the header): answered, and the process gone with no result since.
            what = (" its CLI outlived its tmux session and may still run the turn the answer started; `unstick --kill`"
                    " resumes it in a new session" if state == "ORPHANED" else
                    " the turn the answer started died; read its log, then resume it by hand")
            return self.attention(worker, turn, "state", f"the worker is {state} on {worker.box} after {label(turn)} was answered,"
                                                         f" and no turn has ended since:{what}")
        if last is not None and last.get("status") in FINAL:
            return
        if state in GONE:
            return self.attention(worker, turn, "state", f"the worker is {state} on {worker.box}, no returned turn")
        if not RETURNED.fullmatch(state):
            return  # a status line that is no state's (a transient failure): read again next tick
        if worker.count == "results" and state == "IDLE" and not self.replied(read):
            return  # a message the CLI has not echoed yet: this idle turn is not its reply
        if last is not None and last.get("status") in OPEN_REVIEW:
            return self.collect(worker, turn, last)
        if last is not None and last.get("status") == "retry" and now() < float(last.get("next", 0)):
            return
        ended = self.call("attach", worker.box, worker.name, timeout=ATTACH_WAIT)
        if ended.rc in (4, 124):
            return  # the box did not answer, or the worker runs again: next tick
        verdict = substitution(ended.out).splitlines()[-1] if ended.out.strip() else ""
        if not verdict.startswith("DONE ") and not (worker.count == "results" and verdict.startswith("IDLE ")):
            return self.attention(worker, turn, "turn", f"the turn did not complete: {verdict[:300] or f'attach exit {ended.rc}'}")
        message = self.turn_file(worker, turn, "md")
        if worker.count == "results":
            # THE RE-READ (the header): the message is turn n's only if the count still says n.
            got_log = self.confirmed(worker, turn)
            if got_log is None:
                return
            read_log = got_log
        else:
            read_log = self.call("log", worker.box, worker.name, "--last-result")
            if read_log.rc == 4:
                return
        if read_log.rc != 0:
            return self.attention(worker, turn, "turn", f"the turn ended with no final message ({substitution(read_log.out)[-200:]})")
        write_atomically(message, read_log.out)
        what = classify(read_log.out)
        match what.kind:
            case "windows":
                self.attention(worker, turn, "windows", "Windows witness needs the coordinator; no execution assign attempted", message)
            case "request":
                requests = message
                if what.request_text:
                    requests = self.turn_file(worker, turn, "request.md")
                    write_atomically(requests, what.request_text)
                self.assign(worker, turn, message, last, requests=requests)
            case "result":
                self.conclude(worker, turn, message, what)
            case "review" | "confirm":
                self.review(worker, turn, what)
            case "handback":
                self.handback(worker, turn, message, what)
            case _:
                if what.markerless and worker.fields.get("kind") == "gemini":
                    self.reprompt(worker, turn, message, what.why, last)
                else:
                    self.attention(worker, turn, "turn", what.why, message)

    def open_review(self, worker: Worker, turn: int) -> dict[str, Any] | None:
        """A Claude worker's earlier turn whose review still runs: its count moved past it (a turn the
        worker began on its own), which no reading of the current count would find."""
        if worker.count != "results":
            return None
        lasts: dict[int, dict[str, Any]] = {}
        for e in self.ledger:
            if (e.get("task") == worker.task and e.get("worker") == worker.name and e.get("session") == worker.session
                    and e.get("count") == worker.count and isinstance(e.get("turn"), int) and 0 <= e["turn"] < turn):
                lasts[e["turn"]] = e
        pending = [e for _, e in sorted(lasts.items()) if e.get("status") in OPEN_REVIEW]
        return pending[0] if pending else None

    @staticmethod
    def replied(read: re.Match[str] | None) -> bool:
        """An IDLE stream worker's line shows its turn ended, no background task listed and every
        message it was sent echoed (``turn=ended background_tasks=0 unread=0``). The fields are read
        after the state on the far side, so they can show a turn that began since it read IDLE."""
        chan = CHANNEL.search(read.string) if read is not None else None
        return chan is not None and chan.groups() == ("ended", "0", "0")

    def confirmed(self, worker: Worker, turn: int) -> Done | None:
        """``log --last-result`` of a Claude worker's turn, kept only when THE RE-READ (the header)
        still shows that turn returned; None when it does not, or the box did not answer."""
        read_log = self.call("log", worker.box, worker.name, "--last-result")
        if read_log.rc == 4:
            return None
        again = self.reading(worker)
        if again is None or again[1] != worker.session or again[2] != turn or not RETURNED.fullmatch(again[0]) or (
                again[0] == "IDLE" and not self.replied(again[3])):
            return None
        return read_log

    def resume(self, worker: Worker, turn: int, kind: str, message: str, text: str, **more: Any) -> bool:
        done = self.call("unstick", worker.box, worker.name, "--message", message, gated=True)
        if done.rc != 0:
            self.attention(worker, turn, kind, f"{text}, and the worker was NOT resumed (unstick exit {done.rc}:"
                                               f" {substitution(done.out)[-200:]}); resume it with {message}", message)
            return False
        self.note(worker, turn, kind, "answered", text + said(self.err), **more)
        return True

    def reprompt(self, worker: Worker, turn: int, message: str, why: str, last: dict[str, Any] | None) -> None:
        if last is not None and last.get("status") == "reprompting":
            self.attention(worker, turn, "reprompt", "the re-prompt may have been sent before the driver stopped;"
                                                   " check the worker before resuming it", message)
            return
        if any(e.get("task") == worker.task and e.get("worker") == worker.name and e.get("session") == worker.session
               and e.get("status") == "reprompting" for e in self.ledger):
            self.attention(worker, turn, "turn", why, message)
            return
        reply = self.turn_file(worker, turn, "reprompt.md")
        markers = ", ".join(token for token in MARKER_TOKENS if token not in ("PLAN_READY", "END_PLAN_READY"))
        write_atomically(reply, f"Please resend the same final message with its handoff marker on the first line."
                                f" The driver reads {markers}. For REVIEW_REQUEST and CONFIRM_REQUEST,"
                                " send the marker line by itself so it is also the last line.\n")
        self.note(worker, turn, "reprompt", "reprompting", why, file=message, reply=reply)
        self.resume(worker, turn, "reprompt", reply, f"asked for the same final message with a marker first ({reply})")

    def assign(self, worker: Worker, turn: int, message: str, last: dict[str, Any] | None, *, requests: str) -> None:
        out = self.turn_file(worker, turn, "assigned.md")
        status_file = self.turn_file(worker, turn, "assign-status.json")
        stale = False  # a file left by an earlier try of this turn, which this call cannot be told from
        try:
            os.unlink(status_file)
        except FileNotFoundError:
            pass
        except OSError:
            stale = True
        done = self.call("execution", "assign", self.path("reserve", f"{worker.task}-base.json"), requests,
                         "--message", out, "--unstick", worker.box, worker.name, "--status", status_file)
        status = None if stale else assign_status(status_file, done.rc)
        if done.rc == LEASE_LOST_STATUS:
            where = status["lease_lost"] if status is not None and status["lease_lost"] else "one of its calls"
            raise LeaseLost(f"execution assign exit {done.rc}: the lease refused {where}")
        earlier = ALREADY.findall(self.err)
        # Every answer carries the tally lines of the unstick assign ran (none when it ran none); a printed
        # message with no readable status says its count is unread rather than nothing.
        counted = suffix(status["tally"]) if status is not None else (
            f"; no readable assign status ({status_file}): its unstick's tally is unread" if done.out.strip() else "")
        if done.rc == 0 and not done.out.strip():
            # Nothing assigned by this call: an earlier one dispatched every block and never resumed the worker.
            if os.path.isfile(out):
                self.resume(worker, turn, "request", out, f"dispatched by an earlier call; resumed with its saved message {out}")
                return
            return self.attention(worker, turn, "request", "every block was dispatched by an earlier call, the worker was not"
                                  " resumed, and no assignment message was saved: resume it by hand with its assignments", message)
        if done.rc == 0 and earlier:
            # Some blocks assigned now and some by an earlier call whose message never reached the worker.
            return self.attention(worker, turn, "request", f"the worker was resumed with part of its assignments ({out}): an"
                                  f" earlier call had dispatched {', '.join(earlier)} and its message is not in this one; send"
                                  f" the worker those assignments{counted}", message)
        if done.rc == 0:
            return self.note(worker, turn, "request", "answered", f"assigned and resumed with {out}{counted}")
        if done.rc in (1, ASSIGN_ACTION_REQUIRED) and done.out.strip():
            return self.attention(worker, turn, "request", "execution assign refused some of the turn's blocks and resumed the"
                                  f" worker with the rest ({out}); its lines name the refused ones, which the worker still waits"
                                  f" for{counted}", message)
        if done.rc == ASSIGN_ACTION_REQUIRED:
            report = self.err.rstrip("\n").rpartition("\n")[2]
            detail = report[len(ACTION_REQUIRED_LINE):] if report.startswith(ACTION_REQUIRED_LINE) else ""
            detail = detail or "read the assignment diagnostic before retrying"
            return self.attention(worker, turn, "request", f"execution assign needs action before retrying: {detail}", message)
        tries = int(last.get("tries", 0)) + 1 if last is not None and last.get("status") == "retry" else 1
        if done.rc == 1 and tries < TRIES:
            return self.note(worker, turn, "request", "retry", f"execution assign refused a block (try {tries} of {TRIES})",
                             tries=tries, next=now() + RETRY)
        resumed = ""
        if done.rc == 4:
            # Only a landed unstick says the worker has its message; a failed or unread one may have reached it.
            # No message printed: assign never reached its unstick, whatever became of its status.
            outcome = status["unstick"] if status is not None else "unreadable" if done.out.strip() else "nothing-assigned"
            resumed = (f"; its unstick landed: the worker was resumed with {out}" if outcome == "landed" else
                       f"; no unstick of assign's is known to have landed ({outcome}): reconcile the worker's state"
                       f" before sending it {out}, and never assign again" if outcome in ("failed", "unreadable") else
                       f"; no unstick of assign's ran ({outcome}): the worker was not sent its assignments")
        self.attention(worker, turn, "request", f"execution assign exit {done.rc}" + (f" after {tries} tries" if done.rc == 1 else "")
                       + f": read its lines before anything else{resumed}; the request is in the turn's message{counted}", message)

    def conclude(self, worker: Worker, turn: int, message: str, what: Turn) -> None:
        lines: list[str] = []
        for raw in what.results:
            try:
                data: Any = json.loads(raw)
            except ValueError:
                data = None
            result = cast(dict[str, Any], data) if isinstance(data, dict) else {}
            request, where, sha = result.get("request_id"), result.get("run"), result.get("observed_sha")
            if not (isinstance(request, str) and request and isinstance(where, str) and where.startswith("/")
                    and isinstance(sha, str) and SHA40.fullmatch(sha)):
                return self.attention(worker, turn, "result", "an EXECUTION_RESULT line names no request_id, absolute run and"
                                                              " 40-hex observed_sha; nothing more concluded", message)
            verdict = ""
            for form in ("--from-run", "--from-bg-run"):
                done = self.call("execution", "conclude", form, where, "--request", request, "--sha", sha, gated=True)
                if done.rc == 0:
                    try:
                        record: Any = json.loads(done.out)
                    except ValueError:
                        record = None
                    verdict = str(cast(dict[str, Any], record).get("verdict", "")) if isinstance(record, dict) else ""
                    break
            if not verdict:
                return self.attention(worker, turn, "result", f"{request} could not be concluded off {where} (neither run record"
                                                              " reads); worker was NOT resumed: reconcile this completed run and conclude it by hand,"
                                                              " then relay to the worker: run future assigned commands under bg-run.sh new/start"
                                                              " (native Claude: spawn/wait) and report that record's directory as run, not its runs/"
                                                              " parent or a plain log directory; the run-record rule beside EXECUTION_RESULT in Requests also allows"
                                                              " tools/test-run.sh paths run last when the assignment itself is the project runner;"
                                                              " do not rerun this completed command", message)
            lines.append(f"EXECUTION_CONCLUDED {request} {verdict}")
        out = self.turn_file(worker, turn, "concluded.md")
        write_atomically(out, "\n".join(lines) + "\n\nContinue with your task.\n")
        self.resume(worker, turn, "result", out, "; ".join(lines))

    def review(self, worker: Worker, turn: int, what: Turn, *, replay: bool = False) -> None:
        mine = (worker.name, worker.session, turn, worker.count)
        again = not replay and any(e.get("task") == worker.task and (e.get("worker"), e.get("session"), e.get("turn"), e.get("count", "resumes")) != mine
                    and e.get("status") == "answered" and e.get("kind") == what.kind and e.get("pr") == what.pr
                    and e.get("sha") == what.sha for e in self.ledger)
        subject: list[str] = []
        for key, flag in (("issue", "--issue"), ("source", "--source")):
            ref = REF.fullmatch(worker.fields.get(key, ""))
            if ref and not subject:
                subject = [flag, ref.group(1)]
        kind = "at-open" if what.kind == "review" else "confirm"
        runs = self.path("logs", "drive-runs")
        os.makedirs(runs, exist_ok=True)
        helper = os.path.join(self.cfg.here, "bg-run.sh")
        rc, out, _ = execute([helper, "spawn", runs, "--", *self.gated_shim, "wave", "review", self.wave.path, worker.task, what.pr,
                              what.sha, "--kind", kind, *subject, *(["--again"] if again else [])])
        where = substitution(out).splitlines()[-1] if out.strip() else ""
        if rc != 0 or not where.startswith("/"):
            return self.attention(worker, turn, what.kind, f"the review could not be started (bg-run.sh spawn exit {rc})")
        self.note(worker, turn, what.kind, "reviewing", f"wave review {kind} of #{what.pr} at {what.sha[:8]} started in {where}",
                  run=where, pr=what.pr, sha=what.sha)

    def collect(self, worker: Worker, turn: int, last: dict[str, Any]) -> None:
        where, kind = str(last.get("run", "")), str(last.get("kind"))
        if last.get("status") == "review-interrupted":
            return self.review(worker, turn, Turn(kind, pr=last["pr"], sha=last["sha"]), replay=True)
        rc, out, _ = execute([os.path.join(self.cfg.here, "bg-run.sh"), "wait", where, "--within", "1"])
        line = substitution(out).splitlines()[-1] if out.strip() else ""
        verdict = bgrun.parse(line, rc)
        if verdict is not None and verdict.word in (bgrun.Word.RUNNING, bgrun.Word.STARTING):
            return
        log = os.path.join(where, "log")
        if verdict is not None and verdict.status == LEASE_LOST_STATUS:
            reason = f"wave review exit {verdict.status}, log {log}"
            self.note(worker, turn, kind, "review-interrupted", reason, run=where, pr=last["pr"], sha=last["sha"])
            raise LeaseLost(reason)
        said: re.Match[str] | None = None
        if verdict is not None and verdict.word is bgrun.Word.RC and verdict.status == 0:
            try:
                with open(log, encoding="utf-8", errors="replace") as f:
                    found = [m for m in (REVIEWED.fullmatch(text.rstrip("\n")) for text in f) if m]
            except OSError:
                found = []
            said = found[-1] if found else None
        if said is None:
            return self.attention(worker, turn, kind, f"the review did not end with a verdict ({line or 'no wait line'}); its log"
                                                      " says why, and the worker waits", log)
        decision, message = said.group(1), said.group(2)
        if decision == "unreadable":
            # Told before the worker is resumed and the turn made final, so no crash in between loses it.
            self.tell(worker, turn, "the review ended on no verdict line: the worker is told to ask for a confirm; the review"
                                    " is yours to read", message)
        # pr and sha on the answered line are what a later turn's --again reads.
        self.resume(worker, turn, kind, message, f"decision={decision}, resumed with {message}", pr=last.get("pr"), sha=last.get("sha"))

    def unconfirmed(self, pr: str) -> bool:
        """THE CONFIRM (the header): whether the PR's merge is one no posted clearance covers."""
        def records(kind: str) -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for path in glob.glob(glob.escape(self.path("reviews")) + f"/{pr}-{kind}-*.json"):
                if not re.fullmatch(re.escape(pr) + "-" + kind + r"-[0-9a-f]{12}(\.r[0-9]+)?\.json", os.path.basename(path)):
                    continue
                try:
                    with open(path, encoding="utf-8") as f:
                        data: Any = json.load(f)
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict) and cast(dict[str, Any], data).get("comment") and isinstance(cast(dict[str, Any], data).get("at"), str):
                    out.append(cast(dict[str, Any], data))
            return out

        opened = records("at-open")
        if not opened:
            return False
        newest = max(opened, key=lambda r: str(r["at"]))
        if newest.get("decision") not in ("confirm", "unreadable"):
            return False
        since = [r for r in records("confirm") if str(r["at"]) > str(newest["at"])]
        latest = max(since, key=lambda r: str(r["at"])) if since else None
        if latest is None or latest.get("decision") != "cleared":
            return True  # no confirm since, or the last word of the confirms withholds the clearance
        rc, out, _ = execute(["gh", "pr", "view", pr, "--repo", self.wave.repository, "--json", "headRefOid", "--jq", ".headRefOid"])
        return rc != 0 or out.strip() != str(latest.get("sha"))

    def handback(self, worker: Worker, turn: int, message: str, what: Turn) -> None:
        pr = worker.fields.get("pr", "") or what.pr
        kept = self.path("handbacks", f"{worker.task}.md")
        os.makedirs(os.path.dirname(kept), exist_ok=True)
        with open(message, encoding="utf-8", errors="surrogateescape") as f:
            contents = f.read()
        write_atomically(kept, contents)
        runs = [
            path for m in re.finditer(r"^RUN (/[^\r\n]+)\r?$", contents, re.MULTILINE)
            if (path := m.group(1).rstrip()) != "/"
        ]
        if not pr and not runs:
            return self.attention(worker, turn, "handback", "the hand-back names no PR (the row has none, the message no"
                                                            " /pull/<n>); close the task by hand", kept)
        # THE CONFIRM is read, and the coordinator told, before the close: a closed row is served no
        # more, so a driver killed after the close could never come back to say it.
        uncovered = (f"the hand-back reports #{pr} merged, with a blocking review and no cleared confirm of the merged head on"
                     " record; the task is being closed") if pr and self.unconfirmed(pr) else ""
        if uncovered:
            self.tell(worker, turn, uncovered, kept)
        form = ["--pr", pr] if pr else ["--no-pr", *[arg for directory in runs for arg in ("--run", directory)]]
        done = self.call("board", "close", self.wave.wave, worker.task, *form, "--evidence", f"hand-back {kept}", gated=True)
        said = substitution(done.out).splitlines()[-1] if done.out.strip() else f"board close exit {done.rc}"
        if done.rc != 0:
            return self.attention(worker, turn, "handback", f"board close refused: {said}", kept)
        if uncovered:
            return self.note(worker, turn, "handback", "attention", f"{uncovered} ({said})", file=kept)
        self.note(worker, turn, "handback", "answered", said)

    # --- the queue ----------------------------------------------------------------------------------

    def launches(self, doc: dict[str, Any]) -> None:
        """THE QUEUE (the header): the first due task started, at most one a tick."""
        queue = read_queue(self.wave)
        if queue is None:
            return
        if not self.wave.vars.get("MAIN"):
            queue = f"{self.wave.path} names no vars.MAIN, the branch a queued task is prepared at"
        if isinstance(queue, str):
            if queue != self.queue_refusal:
                self.say(f"DRIVE QUEUE REFUSED {self.wave.wave}: {queue}; nothing is launched until it reads")
                self.tell_queue(f"the queue is refused: {queue}; nothing is launched until it reads")
            self.queue_refusal = queue
            return
        self.queue_refusal = ""
        capacity, tasks = queue
        queued_tasks = {task.task for task in tasks}
        rows = dict(rows_of(doc))
        live = slots_held(doc)
        # A SLOT HELD (the header): a launch that may have started a worker whose row does not say so yet.
        launch_ends: dict[str, dict[str, Any]] = {str(e.get("task")): e for e in self.ledger if e.get("turn") == LAUNCH}
        for task, entry in launch_ends.items():
            if entry.get("holds") and state_word(rows.get(task, {}).get("state", "pending")) == "pending":
                live[str(entry["holds"])] = live.get(str(entry["holds"]), 0) + 1
        admitted: bool | None = None  # launches not halted and THE GATE open, read once a tick and only when wanted

        def admits(slot: Worker) -> bool:
            nonlocal admitted
            if admitted is None:
                admitted = self.call("halted").rc == 0 and self.gate_open(slot)
            return admitted

        for queued in tasks:
            slot = Worker(queued.task, "", queued.host, {})
            last = self.last(slot, LAUNCH)
            row = rows.get(queued.task)
            if (last is not None and last.get("status") in (*FINAL, CUED)) or (
                    row is not None and state_word(row.get("state", "")) != "pending"):
                continue
            if last is not None and last.get("status") == "launching":
                self.attention(slot, LAUNCH, "launch", "a launch of the task was begun and its end was not recorded (the driver stopped"
                                                       f" meanwhile): read its worker's status on {last.get('holds')}; the task is yours from here",
                               holds=last.get("holds"))
                continue
            states = {dep: state_word(rows.get(dep, {}).get("state", "")) for dep in queued.after}
            ended = sorted(dep for dep, word in states.items() if word in DONE_STATES and word not in LANDED)
            if ended:
                self.attention(slot, LAUNCH, "launch", f"the queued task cannot come due: {', '.join(ended)}, which it comes after, ended"
                                                       f" without a merge ({states[ended[0]]}); launch it by hand, or take it off the queue")
                continue
            missing = tuple(sorted(dep for dep in states if dep not in rows and dep not in queued_tasks))
            if not missing:
                self.queue_missing.pop(queued.task, None)
            if any(word not in LANDED and dep not in missing for dep, word in states.items()):
                continue
            if queued.native:
                # A NATIVE ENTRY (the header): cued once when due, and never prepared, launched or counted.
                if missing and self.queue_missing.get(queued.task) == missing:
                    continue
                if not admits(slot):
                    return  # a halt, a closed gate or an unreachable anchor is the next tick's, for every task
                if missing:
                    self.tell_missing(slot, queued, missing)
                    continue
                merged = f"its after tasks {', '.join(queued.after)} merged" if queued.after else "it waits on no task"
                self.tell(slot, LAUNCH, f"{queued.task} is due: launch it ({merged}, launches not halted, the launch gate open):"
                                       f" wave prep{' --tier ' + queued.tier if queued.tier else ''}, then gate --wait right before the spawn")
                self.note(slot, LAUNCH, "launch", CUED, f"{queued.task} is due ({merged}); the coordinator launches it")
                continue  # a cue starts nothing, so it takes no tick's launch
            record = self.prepared(queued.task) if row is not None else None
            if record is not None and record.host != queued.host:
                self.attention(slot, LAUNCH, "launch", f"the task is prepared on {record.host}, and the queue names {queued.host} for it:"
                                                       " a prepared task launches where it was prepared; launch it by hand")
                continue
            if live.get(queued.host, 0) >= capacity[queued.host]:
                continue
            if last is not None and last.get("status") == "retry" and now() < float(last.get("next", 0)):
                continue
            if missing and self.queue_missing.get(queued.task) == missing:
                continue  # already told: do not spend another potentially blocking gate read on it
            if admits(slot):
                if missing:
                    self.tell_missing(slot, queued, missing)
                    continue  # a missing prerequisite must not hold up another due task
                self.start(queued, slot, row, record, last)
            return  # one launch a tick, and a halt, a closed gate or an unreachable anchor is the next tick's

    def tell_missing(self, slot: Worker, queued: Queued, missing: tuple[str, ...]) -> None:
        """The missing-prerequisite notice (THE QUEUE, the header), told once per unchanged list: one text for both kinds."""
        which, then = ("queued native task", "it is cued") if queued.native else ("queued task", "this task will still start")
        self.tell(slot, LAUNCH, f"the {which} waits only on after tasks with no row or queue entry: {', '.join(missing)};"
                               f" check their names, or launch them when ready; {then} when they merge")
        self.queue_missing[queued.task] = missing

    def prepared(self, task: str) -> Record | None:
        """A prepared task's launch record, or None when its manifest does not read (``wave launch`` says why)."""
        try:
            return read_manifest(self.path("prep", f"{task}.json"), task)[1]
        except Stop:
            return None

    def unprepping(self, task: str) -> bool:
        """The task's manifest ends with ``wave unprep``'s fence (waveunprep.FENCE): an un-prepare that stopped part-way."""
        try:
            with open(self.path("prep", f"{task}.json"), encoding="utf-8") as f:
                data: Any = json.load(f)
        except (OSError, ValueError):
            return False
        steps: Any = cast(dict[str, Any], data).get("done") if isinstance(data, dict) else None
        return isinstance(steps, list) and cast(list[Any], steps)[-1:] == [FENCE]

    def gate_open(self, slot: Worker) -> bool:
        """THE GATE (the header)."""
        if now() < self.gate_next:
            return False
        done = self.call("gate", "--target-repo", self.wave.repository, "--base-branch", self.wave.vars["MAIN"], "--no-wait", gated=True)
        if done.rc != 4:
            self.gate_pending_tip = None
            self.gate_pending_told = False
        if done.rc == 0:
            self.gate_refusal = ""
            return True
        if done.rc == 4:
            rc, tip, _ = execute(["git", "-C", self.wave.checkout, "ls-remote", "origin",
                                  f"refs/heads/{self.wave.vars['MAIN']}"], timeout=10)
            fields = tip.split()
            sha = fields[0] if rc == 0 and len(fields) == 2 and SHA40.fullmatch(fields[0]) and fields[1] == f"refs/heads/{self.wave.vars['MAIN']}" else ""
            if sha != self.gate_pending_tip:
                self.gate_pending_tip, self.gate_pending_since, self.gate_pending_told = sha, now(), False
            elif not self.gate_pending_told and now() - self.gate_pending_since >= 600:
                self.tell(slot, LAUNCH, f"the launch gate has stayed pending (no verdict, or the anchor did not answer) for at least 600 s;"
                          f" tip sample {sha or 'unreadable'};"
                          " no queued task is admitted; retrying next tick")
                self.gate_pending_told = True
            return False  # pending snapshot or unanswered anchor: try the next tick
        self.gate_next = now() + RETRY
        lines = [line for line in (substitution(done.out) + "\n" + self.err).splitlines() if line.strip()]
        why = (lines[-1].strip() if lines else f"gate exit {done.rc}")[:300]
        if why != self.gate_refusal:
            self.tell(slot, LAUNCH, f"the launch gate refuses, so no queued task is prepared or launched until it passes (read again every {RETRY} s): {why}")
        self.gate_refusal = why
        return False

    def next_launch_id(self, task: str) -> str:
        """Next 1-based launch-attempt id for ``task``, past both recorded ``launching`` lines and ids."""
        prefix = launch_attempt_id(self.wave.wave, task, 1).rsplit("-", 1)[0] + "-"
        pattern = re.compile(re.escape(prefix) + r"([1-9][0-9]*)")
        seen = 0
        highest = 0
        for e in self.ledger:
            if e.get("task") != task or e.get("turn") != LAUNCH:
                continue
            if e.get("status") == "launching":
                seen += 1
            lid = e.get("launch_id")
            if isinstance(lid, str) and (m := pattern.fullmatch(lid)):
                highest = max(highest, int(m.group(1)))
        return launch_attempt_id(self.wave.wave, task, max(seen, highest) + 1)

    def start(self, queued: Queued, slot: Worker, row: dict[str, str] | None, record: Record | None, last: dict[str, Any] | None) -> None:
        main = self.wave.vars["MAIN"]
        checkout = self.wave.checkout
        fetched = execute(["git", "-C", checkout, "fetch", "-q", "origin", main])[0]
        rc, sha, _ = execute(["git", "-C", checkout, "rev-parse", "--verify", "-q", f"refs/remotes/origin/{main}^{{commit}}"])
        if fetched != 0 or rc != 0 or not SHA40.fullmatch(sha.strip()):
            return  # the remote did not answer: the next tick's
        fenced = self.unprepping(queued.task)
        if fenced or (record is not None and record.base != sha.strip()):
            if not fenced and row and row.get("reassignment_reason") and not queued.reassignment_reason:
                return self.attention(slot, LAUNCH, "launch", "the base moved and the pending row records a reassignment reason"
                                      " absent from the queue; the row is kept, and re-prep and launch are yours")
            # A STALE PREPARED TASK (the header): un-prepared here, prepared again at the tip on a later tick.
            # A fenced manifest, its row there or not, is an un-prepare that stopped: it is finished first.
            moved = (f"{main} moved since the task was prepared at {record.base[:12]} (now {sha.strip()[:12]})" if not fenced and record
                     else "an un-prepare of the task stopped before it ended (its manifest ends with the fence)")
            done = self.call("wave", "unprep", self.wave.path, queued.task, gated=True)
            said = (substitution(done.out).splitlines() or [f"wave unprep exit {done.rc}"])[-1]
            if done.rc == 4:
                return  # a read that did not answer: the next tick's
            if done.rc != 0:
                return self.attention(slot, LAUNCH, "launch", f"{moved}, and a prepared task launches at its base only; its un-prepare"
                                                              f" refused: {said[:300]}; it is yours")
            self.tell(slot, LAUNCH, f"{moved}: un-prepared, to be prepared again at the tip under its own id: {said[:300]}")
            return self.note(slot, LAUNCH, "launch", "unprepared", said[:300])
        if row is None:
            # THE REFRESH (the header): the served checkout's prep code, brought to its origin first.
            refreshed = self.call("refresh", self.wave.agent_host)
            fresh = "" if refreshed.rc == 0 else (substitution(refreshed.out).splitlines() or [f"refresh exit {refreshed.rc}"])[-1]
            done = self.call("wave", "prep", self.wave.path, queued.task, "--base", sha.strip(), "--profile", queued.profile,
                             *(["--host", queued.host] if queued.host != self.wave.agent_host else []),
                             *(["--legs", ",".join(queued.legs)] if queued.legs else []),
                             *(["--mode", queued.mode] if queued.mode else []),
                             *(["--issue", queued.issue] if queued.issue else []),
                             *(["--source", queued.source] if queued.source else []),
                             *(["--tier", queued.tier] if queued.tier else []),
                             *(["--reassignment-reason", queued.reassignment_reason] if queued.reassignment_reason else []), gated=True)
            if done.rc == 4:
                return
            if done.rc != 0:
                said = (substitution(done.out).splitlines() or [f"wave prep exit {done.rc}"])[-1]
                return self.attention(slot, LAUNCH, "launch", f"the queued task was not prepared: {said[:300]}; launch it by hand"
                                      + (f" (the refresh of {self.wave.agent_host}'s skills checkout before it: {fresh[:300]})" if fresh else ""))
        host = record.host if record is not None else queued.host
        launch_id = self.next_launch_id(queued.task)
        with tempfile.TemporaryDirectory(prefix="ludics-drive-launch-") as status_dir:
            status_file = os.path.join(status_dir, "status.json")
            # A SLOT HELD (the header): the launch is on record before it is made, so a driver that stops
            # inside it leaves a line the next one reads. Create the status directory first so a
            # temp-directory error cannot leave a slot held without invoking wave launch.
            self.note(slot, LAUNCH, "launch", "launching", f"wave launch on {host}", holds=host, launch_id=launch_id)
            try:
                done = self.call("wave", "launch", self.wave.path, queued.task,
                                 "--status", status_file, "--launch-id", launch_id, gated=True)
            except LeaseLost:
                status = read_wave_launch_status(status_file, LEASE_LOST_STATUS, self.wave.wave, queued.task, host, launch_id)
                if status is not None and status["outcome"] == "pre-start":
                    self.note(slot, LAUNCH, "launch", "lease-lost",
                              f"wave launch on {host} lost the lease before starting anything; slot hold released",
                              launch_id=launch_id)
                raise
        said = (substitution(done.out).splitlines() or [f"wave launch exit {done.rc}"])[-1]
        if done.rc == 0:
            if queued.mode and queued.mode != "none":
                # A PAIRED LAUNCH (the header): the planner must read the tree the worker launched from.
                base = record.base if record is not None else sha.strip()
                self.tell(slot, LAUNCH, f"launched {queued.mode} at {base}: start its peer planner on that sha"
                                       f" with --wave {shlex.quote(self.wave.wave)} --task {shlex.quote(queued.task)}"
                                       " (paired-planning.md, Coordinator, step 1)")
            return self.note(slot, LAUNCH, "launch", "answered", said, launch_id=launch_id)
        gate = PRESTART.search(said) or PRESTART.search(self.err)
        if done.rc == 1 and gate:
            said = gate.group(0).strip()
            tries = int(last.get("tries", 0)) + 1 if last is not None and last.get("status") == "retry" else 1
            if tries == 1:
                self.tell(slot, LAUNCH, f"the queued launch was refused and is tried again every {RETRY} s: {said[:300]}")
            return self.note(slot, LAUNCH, "launch", "retry", said[:300], tries=tries, next=now() + RETRY, launch_id=launch_id)
        # A SLOT HELD (the header): only wave launch's own refusal is known to have started nothing.
        started_nothing = done.rc == 1 and said.startswith("WAVE LAUNCH REFUSED ")
        self.attention(slot, LAUNCH, "launch", f"wave launch exit {done.rc}: {said[:300]}; the task is yours from here",
                       launch_id=launch_id, **({} if started_nothing else {"holds": host}))

    # --- the loop -----------------------------------------------------------------------------------

    def round(self, only: str = "") -> int:
        """One tick over the wave's CLI workers (``only``: one task). 0, or the status to end with."""
        doc = board_document(self.cfg, self.wave.wave)
        if doc == 4:
            return 0  # the anchor did not answer: next tick
        if isinstance(doc, int):
            cli.say(f"DRIVE STOPPED {self.wave.wave}: its board cannot be read (above)")
            return 1
        self.load()
        workers = workers_of(doc)
        if only and not any(w.task == only for w in workers):
            cli.say(f"DRIVE REFUSED {self.wave.wave}: {only} is no live CLI worker's task on the board")
            return 1
        for worker in workers:
            if not only or worker.task == only:
                self.tick(worker)
        if not only:
            self.launches(doc)
        return 0


def locked(cfg: Config, wave: Wave, body: Callable[[Driver], int]) -> int:
    os.makedirs(os.path.join(wave.directory, "logs"), exist_ok=True)
    os.makedirs(os.path.join(wave.directory, "msgs"), exist_ok=True)
    with open(os.path.join(wave.directory, "logs", "drive.lock"), "a", encoding="utf-8") as lock:
        try:
            acquire_startup_lock(lock.fileno())
        except OSError:
            cli.say(f"DRIVE REFUSED {wave.wave}: another driver holds {lock.name}")
            return 1
        try:
            return body(Driver(cfg, wave))
        except LeaseLost as lost:
            cli.say(f"DRIVE STOPPED {wave.wave}: coordinator lease lost ({lost})")
            return 1


def cmd_drive(cfg: Config, args: list[str]) -> int:
    if not args or args[0].startswith("--"):
        die(f"wave drive: name the wave file; usage: {USAGE}")
    poll, once = POLL, False
    rest = args[1:]
    while rest:
        if rest[0] == "--once":
            once, rest = True, rest[1:]
        elif rest[0] == "--poll" and len(rest) > 1 and rest[1].isdigit() and int(rest[1]) > 0:
            poll, rest = int(rest[1]), rest[2:]
        else:
            die(f"wave drive: takes --poll <whole seconds> and --once; usage: {USAGE}")
    wave = load_wave(args[0], "drive")
    stop = os.path.join(wave.directory, "drive.stop")

    def body(driver: Driver) -> int:
        while True:
            if os.path.lexists(stop):
                cli.say(f"DRIVE STOPPED {wave.wave}: stop file {stop}")
                return 0
            rc = driver.round()
            if rc != 0 or once:
                return rc
            sleep(poll)

    return locked(cfg, wave, body)


def cmd_turn(cfg: Config, args: list[str]) -> int:
    if len(args) != 2 or args[0].startswith("--") or not TASK.fullmatch(args[1]):
        die(f"wave turn: name the wave file and the task; usage: {USAGE}")
    wave = load_wave(args[0], "turn")
    return locked(cfg, wave, lambda driver: driver.round(args[1]))
