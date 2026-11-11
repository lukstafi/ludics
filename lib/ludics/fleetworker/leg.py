"""``execution leg``: one reserved run of a project's runner on a fleet box, at an exact commit
(ludics-lite#558).

Every worker that needed a correctness leg on another box hand-wrote the same script -- create or
refresh a worktree at an exact SHA there, run the project's runner, maybe apply a patch that must
make it fail -- and the 2026-10-05 wave paid for each copy: a fetch resolved from a linked worktree,
which cannot see the main checkout's ``FETCH_HEAD``; a hard-coded commit re-pinned twice. This verb
is that script, once, inside the reservation:

    execution leg --request <id> [--box <box>] --rev <sha|branch> --checkout <dir> --worktree <dir>
                  [--remote <name>] [--base <branch>] [--control <patch>] [--file <local file>] [--reads-no-config]
                  [--cpu|--gpu] [--wait <s>] [--wait-window[=<s>]] [--deadline <s>] -- <runner command...>

``execution hold --request <id> --worktree <dir> --rev <rev> [--checkout <dir>]`` is this verb on
the box it runs on, for a measurement (``hold_in_worktree``, ludics-lite#816).

THE RESERVATION. ``--request`` names a dispatched record (``launching``, ``running`` or
``uncertain``; a standing iteration record counts), read from the anchor's registry, which needs no
coordinator identity. The box is the record's execution host (``--box``, when given, must be it);
a correctness record runs the runner under ``execution slot`` on that box (``--cpu``/``--gpu``,
``--wait``, ``--wait-window``, ``--deadline`` passed to it), a measurement under ``execution hold
--request <id>`` (``--deadline`` alone). When the registry binds the record to one commit
(``registry.bound_commit``: a non-standing ``head-of:<branch>`` request's ``resolved_revision``, or a
non-standing request whose ``requested_revision`` is exactly one commit, ludics-lite#634), ``--rev``
must come to exactly that commit; a standing record binds none (ludics#703), so its leg runs any.

THE WINDOW WAIT (ludics-lite#666). A standing record a measurement window has ``suspended`` is
refused at once -- unless the leg was given ``--wait-window[=<s>]``, when it waits here, on the
caller's box, in the slot's own wait (``slot.await_measurements``, in this verb's voice): until no
measurement is outstanding on the record's box and the record is no longer suspended, re-reading
the anchor's registry, for at most the bound (when none is given, to the window's recorded deadline,
or an hour where it records none: ludics-lite#737); past it, refused naming
the measurement, as the slot is. The record counts too, as held by the window it names, because a
listing is no snapshot: a conclusion restores the records it suspended and then concludes the
window, file by file, and an opening publishes the window and then suspends, so one read can show
the window concluded, or not yet listed, beside the record still suspended. A suspension the
registry never ends (which its conclusion rules out) is therefore waited out to the bound like a
window. Then the record is judged as above, and the leg goes on to the box with its flags as given:
a window opened after this wait (the next of a coordinator's back-to-back windows) is the slot's to
wait for there, under its own ``--wait-window``, as for any batch. So these are two waits, each
under the bound, as the slot's own window wait and slot wait are; the bound is not carried across
the setup between them (the copy, the ssh, the fetch), whose time no clock on either side measures
for the other. The leg waits for no window when its record is not suspended: the slot on the box
does, as for any batch.

Its boundary: a bounded, best-effort wait that re-reads the registry. It ends at once when the
record is gone or concluded (a worker handing back mid-window), without the wait's line that the
box is free and the leg runs, which would be false there (ludics#710); otherwise it proceeds only on a
read in which the record is active again; the leg then judges that record as above (launching,
running or uncertain), so it never runs against a record that read showed suspended or concluded.
It refuses loudly on a registry it cannot read at the bound, and at the bound. When a refusal
lands within a poll interval of the window's own end, or which of two failed reads it names, is
outside it.

THE CHECKOUT AND THE REVISION, on the box (paths absolute, or ``~/``): ``--checkout`` is a git
checkout of the project there, ``--worktree`` a LINKED worktree of it (never the main one), made
with ``git worktree add --detach`` when the path does not exist and checked out ``--detach`` at
the commit when it does -- refused when it is another repository's, or has uncommitted changes,
which a leg never overwrites; and refused when it is not clean once at the commit, submodules
included (a submodule the checkout moved past is refused, never updated). A ``~/`` must arrive
quoted: one the caller's shell expanded names that host's home, and a checkout or worktree refused
under a home directory that is not the box's says so (``NOT_HOME``, ludics-lite#669). A runner that is no
executable command in the worktree is refused before it is counted as run. A full SHA already in the checkout is used as it is; anything else is
fetched from ``--remote`` (``origin``) -- a branch as ``refs/heads/<rev>``, so a tag of the same
name is never taken for it -- INTO A PRIVATE REF of the checkout, ``refs/fleet-leg/<pid>``,
and resolved there: never through ``FETCH_HEAD``, which a linked worktree cannot see and which two
legs fetching in one checkout would overwrite. The ref is deleted once the worktree holds the
commit. ``observed_sha`` is the worktree's ``git rev-parse HEAD`` before the runner starts. The fetch is
bounded by FLEET_FETCH_TIMEOUT (300 s). One leg at a time holds a worktree, from its status check
through the control's revert (a flock under ``$STATE/leg-locks``, keyed by the worktree's physical
path, held by every process the leg starts, the runner's wrapper included, so it outlives a far
shell that dies first): a second is refused, never queued, since a worktree moved under a running leg would make it test another commit than the one
it reports.

THE BASE (ludics#1042). A leg's worktree on macbook-pro computed its reach against a stale
``origin/master``: the project's ``affected`` counted 65 changed paths where the real diff had 4, and
the leg ran that scope. The revision's fetch writes only its private ref, and a SHA already in the
checkout fetches nothing, so a reused far-side checkout's remote-tracking refs stood at whatever its
last ``git fetch`` left. So, once the commit is resolved and before the worktree moves, the leg
fetches ONE branch, the base, into its remote-tracking ref of the checkout
(``+refs/heads/<branch>:refs/remotes/<remote>/<branch>``, which the worktree shares): the branch
``--base <branch>`` names -- the launch's fact (a project's base, ``main`` or ``master``), checked as a
branch name -- or, with none, the one the checkout's ``refs/remotes/<remote>/HEAD`` names (the
remote's default branch, as ``git clone`` recorded it). ``FLEET_BASE_REF`` is not read: it is the
site's one launch default (``origin/master``), not this project's. It is said, ``EXECUTION LEG <box>:
base <remote>/<branch> at <sha> (<--base|<remote>/HEAD>), fetched from <remote> before the run; was
<old sha|unset>``, so the log names the base the runner saw. A fetch that fails (retried once, a
second later: a concurrent fetch of that ref holds its lock) or reaches FLEET_FETCH_TIMEOUT REFUSES the
leg, nothing run: the leg exists to keep a wrong scope from reporting green, and a runner whose diff
reads no base asks only for a reachable remote, which its revision's fetch needs anyway. A checkout
with no ``<remote>/HEAD`` and no ``--base`` is a WARNING, and the leg goes on: there is no base to
name, and the warning says how to name one. The boundary: the checkout's remote-tracking ref of that
one branch is all it writes -- no checkout, reset or branch of the checkout moves (a served clone
stays on its branch), no other ref is fetched, and ``<remote>/HEAD`` is read, never set. It
establishes that ``<remote>/<branch>`` is the remote's tip at the leg's start, not that the runner
diffs against it: which ref a project's reach reads, and how (a merge base, ``FETCH_HEAD``, another
remote), is the project's. A base that moves during the run is not followed.

THE FREE-SPACE FLOOR (ludics#981). A disk left with 17 MB cut off a CUDA integration run with dune
exit 2 and no named failure, and a leg (``run-29``) spent a slot and died mid-checkout. So a leg is
refused, ``EXECUTION LEG REFUSED <box>: only <n> GiB free ...`` naming the box, the free space and the
floor, when the filesystem of ``--checkout`` or of ``--worktree`` (its nearest existing ancestor, for
one not made yet) has less than the selected floor free to this user. A nonempty site knob
FLEET_LEG_MIN_FREE_GIB overrides ``min-free-gib <GiB>`` in ``.github/fleet-leg`` at the tested
commit, which overrides the default 20; all are whole numbers, and 0 disables the check. A project
states its cold-tree requirement; no project tree size is assumed here. The knob is read where
the leg is run, as FLEET_FETCH_TIMEOUT is (the caller or ``~/.config/fleet/env.sh``), and a malformed
knob is a usage error. An explicit site floor is checked before the worktree lock and fetch.
Without it the project/default floor is checked after revision resolution and config parsing,
before ``git worktree add`` and the slot: the requested commit may need fetching to read its floor.
It reads ``shutil.disk_usage`` through ``scripts/py``, which the worktree's lock
needs on the box anyway, rather than ``df``, so no output format and no coreutils are read (GNU,
uutils and BSD alike), and directly rather than under ``bounded``, whose scratch files a full disk
would deny, turning the refusal into a note. A read that fails is a NOTE and the leg goes on: the
floor refuses a disk it has read, never one it could not. Its boundary: one reading, before the
run. What a run then writes, and a filesystem neither path is on (``$STATE``, ``$TMPDIR``), is outside
it; the files a leg copies to the box before its far shell starts are written first, and a refusal
removes them as any refusal does. ``farside-close`` (``ludics.fleetworker.farsideclose``) is what
frees a closed wave's far-side worktrees. ``execution tip-run`` takes the same program and the same
knob (ludics#991; tiprun.py, THE FREE-SPACE FLOOR).

THE RUNNER. The command after ``--`` runs in the worktree, its argv passed untouched (each word
quoted for the box's shell), stdin closed; nothing here names a project's runner. Its status is the
leg's, unchanged -- a 125 or a signal's 128+n survives the trip -- and the last line on stdout is
``execution-leg: exit: <status>``, the sentinel ``conclude --from-bg-run`` reads. This verb prints
that line itself, once the far side has ended, and only when the far side reported the status under
this invocation's own random token (``execution-leg <token>: exit: <status>``, consumed, never
passed through): a runner's output -- a nested leg's sentinel, say -- cannot stand in for it, even
when the connection drops after printing it. A runner's own plain sentinel lines pass through as
output.

Each run (the main one, the control) is a nested ``execution slot --deadline`` inside the leg's slot
or hold, taking none of its own: its process group is reaped when the runner returns, so nothing the
runner left in the background overlaps the next run. The bound is the leg's ``--deadline``, or a
day, for each run; the enclosing slot or hold takes none, so a main run cannot spend the control's.
After the control, the reverted worktree must be clean at the commit again, or it is NO CONTROL.

THE CONTROL. With ``--control <patch>`` (a file on this box, copied to the box's state directory),
the patch must apply (``git apply --check``) before anything runs. After a main run that passed it
is applied, the runner runs again in the same slot and must FAIL, and the patch is reverted. The
leg's status is then 0 when the control failed (1-127 but 124, the slot's deadline); 1 when it
passed (``CONTROL PASSED``: the runner does not see what the patch breaks); the control's own status
when it was cut by the deadline or a signal (124, 128+), the patch reverted all the same; a patch
that cannot be reverted is ``CONTROL NOT REVERTED``, status 1, whatever the control did. A control
that is not exercised is ``NO CONTROL``, status 1, never a pass: its nested slot never started the
runner, the runner was no executable command with the patch applied, or the main run left the
worktree at another commit than the one the leg reports, or not clean. A main run
that failed is the leg's status, and the control does not run.

After the run, beside the warning that the runner moved HEAD, a worktree the runner left with
changed or untracked paths is said (``WARNING: <wt> has N uncommitted path(s) after the run``,
ludics-lite#749): the next leg refuses that worktree, and the runner that auto-promoted goldens into
it should be caught by the leg that ran it. It is a warning, never a status. It is not printed when
the control patch was applied (the after-control check judges that state) or when the main run
already recorded the dirt as NO CONTROL.

WHAT THE STATUS MEANS. The runner's, when the sentinel line was printed. Without it, nothing ran to
an end: an ``EXECUTION LEG REFUSED`` line says why (1; 2 usage; the slot's own refusal status when
the slot never started the runner), or ``EXECUTION LEG UNREACHABLE`` (4) that the box never answered
or the connection dropped, with the runner perhaps started -- find out on the box before a retry.

THE RECORD'S CHECKOUT (ludics-lite#749). A record that names a ``checkout`` (registry.py's THE
CHECKOUT: the one checkout its conclusion reads, for a leg the far-side worktree) refuses a
``--worktree`` that is not it, before anything is copied to the box: a leg under a standing id must
not move another worker's worktree. The comparison is the rule ``conclude --observed-from`` applies,
for a POSIX path (a leg's box is one): lexical, byte-equal once trailing ``/`` are dropped -- a
trailing ``\\`` is a character of the name there, not a separator -- no symlink resolved, no ``~``
expanded, so another spelling of the same directory is refused, naming the recorded one. A record that names none is not checked; ``--checkout`` is not.

THE BACKEND PIN (ludics-lite#766). Four legs meant for CUDA or HIP ran with no backend selected,
resolved to the CPU backend, and reported green. The backend's names are the project's, so the
project states them: ``.github/fleet-leg``, read on the box from the checkout's object store AT THE
COMMIT under test (``git cat-file blob <sha>:.github/fleet-leg``; one holding a NUL byte is refused), before the worktree is touched. Its
grammar, a fail-closed allowlist: blank lines, ``#`` comment lines, and
  - ``pin-flag <option>``: the runner's argv holds ``<option> <value>`` or ``<option>=<value>``, the
    value nonempty, among its words after the first and before its first ``--`` (what follows a
    ``--`` is passed on to something else);
  - ``pin-env <NAME>``: the runner is ``env NAME=<value> ... <command>``, its first word ``env``, NAME's
    last assignment among those that directly follow it nonempty, and a command after them -- any
    command, a ``bash -c '...'`` composite included (ludics#864: a leading ``env`` pin is how a
    composite carries one);
  - ``slot-plan <path>``, at most one: THE SLOT PLAN below;
  - ``run-report <path>``, at most one: THE RUN REPORT below;
  - ``fail-lines <shell command>``, at most one, the rest of the line (no CR): THE FAILING LINES below;
  - ``min-free-gib <GiB>``, at most one, decimal digits only: THE FREE-SPACE FLOOR above.
Any other line refuses the leg, naming it: a file the fleet cannot read is never ignored. A leg that
may hold the GPU -- one that does not declare ``--cpu``, the slot's own fail-closed definition, so a
measurement's too -- whose repository's file names a pin and whose argv satisfies none is refused
before anything runs, naming the forms that pass: the pins, and for a runner that is a shell's
``-c`` string (``sh``, ``bash``, ``dash``, ``zsh``, ``ksh``) the leading ``env`` pin or a long list
shipped with ``--file`` (THE FILE). The boundary: argv words as given, nothing else -- a pin inside a
``sh -c`` string, an environment the caller exported (it does not travel to the box), or a project
file that selects the backend does not count. It establishes that the command NAMES a backend, never
that the run held it: that is the runner's own check (OCANNL's ``--expect-backend``), and no refusal
here is GPU evidence. A repository without the file, a ``--cpu`` leg, and a ``--reads-no-config``
leg are not checked (the file is still parsed for each, so a line this version cannot read refuses
them too).

``--reads-no-config`` (ludics#864) is the caller's declaration that the runner reads none of the
project's configuration -- a standalone C probe of the driver, which no backend variable reaches:
such measurements were refused, then re-run under a meaningless ``env OCANNL_BACKEND=hip``. It
stands where ``--cpu`` stands, a caller's declaration the leg cannot check, and it is said on the
leg's output (``--reads-no-config: ... no backend pin was asked of it``) so a reader of the log sees
that no pin was asked. It is not the project's to grant: the gate is against a forgotten pin, and a
declaration is not one. (Not ``--probe``, the issue's word: ``execution slot --probe`` asks whether
a slot is free, and OCANNL's runner calls it.)

THE FILE (ludics#864). ``--file <local file>`` copies a file of the caller's box (an alias list a
pre-push run reads) to the box's state directory beside the control patch, under the request and the
invocation's token, and each runner word that is exactly ``{file}`` becomes that copy's absolute path,
so a long list reaches the runner as a file it reads (OCANNL's ``--targets-file {file}``) rather than
through a ``sh -c`` that would hide the pin. A ``--file`` with no ``{file}`` word, and a ``{file}``
word with no ``--file``, are usage errors; a word that merely contains ``{file}`` is not replaced. The
copy is removed when the leg ends, as the patch is; it is never in the worktree, which stays clean.

THE SLOT PLAN (ludics#864). A correctness leg that declares neither ``--cpu`` nor ``--gpu`` takes a slot
that may hold the GPU, though its runs may not: a CPU batch holding a GPU token. A project whose
``.github/fleet-leg`` names ``slot-plan <path>`` (relative, in the worktree; no ``..``) states how to
tell: once the worktree is clean at the commit, the leg runs ``<path> <runner argv...>`` there, under an
``execution slot --cpu`` of its own with the leg's slot flags and each run's bound, its stdout shown on
stderr, and only an exit 0 whose last nonblank stdout line is ``cpu`` makes both runs ``--cpu``
(``slot plan <path> ...: cpu``). ``gpu``, another line, a nonzero exit or a path that is no
executable file leave the slot as given, the fail-closed default, said (a WARNING for anything but
``gpu``). A plan that moved HEAD or left the worktree not clean refuses the leg, since the runs would
not be at the commit. The plan is the project's: what it reads (OCANNL's runner has ``plan``, which
names the slot its ``run`` would take) is outside this verb. The boundary: it decides the leg's
slot kind only; the backend pin is judged before it on the leg's own flags, so a leg the plan makes
``--cpu`` was still asked for its pin. A wrong ``cpu`` cannot put a GPU batch past the tokens: a
runner that takes its own slot inside the leg's is refused a GPU batch in a ``--cpu`` slot that is no
GPU token (slot.py, THE NESTED SLOT), and one that does not is the project's plan to keep right. A measurement takes no slot and runs no plan. A stop during the plan ends its wrapper as it
ends a run's, and the leg is refused with nothing run.

THE RUN REPORT (ludics#829). A runner that keeps its detail in a log on the box (OCANNL's
``tools/test-run.sh`` prints a digest, and a test's stderr -- its "(not part of the golden)" tables --
stays in the run's log there) left every worker reading that log over ssh. A project whose
``.github/fleet-leg`` names ``run-report <path>`` (the slot plan's path grammar) states what a reader
of the leg needs: after each run that started (the main run, and the control, before its revert), the
leg runs ``<path> <runner argv...>`` in the worktree, under a nested ``execution slot --deadline 300``
(with the run's ``--cpu``/``--gpu``), and puts its stdout and stderr together, the last 200 lines, on
the leg's stderr between ``EXECUTION LEG <box>: run report <path> after the <main|control> run (exit
<n>), report exit <m>, <count>:`` and ``EXECUTION LEG <box>: end of the run report (<run> run)``,
before the status line: next to the verdict, in the same log. What it prints is the project's (a log's
tail, the lines a reader asks for); the leg reads none of it. Its status is said, never the leg's: a
report that fails, times out or is no executable file (said as such, 127) changes no verdict. The
boundary: the report runs where the run ran, in the slot that held it, so what it leaves in the
worktree is the run's (a moved HEAD or dirt is the main run's NO CONTROL, or the after-run warning);
it runs after no refusal and no run that never started; and a stop ends it as it ends a run. A
runner's own stderr needs no report: it reaches the caller as it is written, over ssh's stderr.

THE FAILING LINES (ludics#1040). A failed leg's log carried the runner's verdict and the names of
the goldens that differ, but not the claims that failed, so each failed GPU leg cost its worker an
ssh session to the far side (ahrefs/ocannl#2075). Which lines are a failure's, and where they are,
are the project's facts: its ``.github/fleet-leg`` names ``fail-lines <shell command>``, the rest of
the line as written (blanks around it dropped). After each run that started and exited nonzero (the
main run, or the control, which must fail, before its revert), the leg runs that command with
``bash -c`` in the worktree, the runner's argv as its ``$1...``, under a nested ``execution slot
--deadline 300`` (with the run's ``--cpu``/``--gpu``), after the run report, and copies its stdout and
stderr together onto the leg's stderr, BOUNDED: its first 16384 bytes, and of those its first 100
lines, between ``EXECUTION LEG <box>: failing lines (fail-lines in .github/fleet-leg) after the
<main|control> run (exit <n>), their command exit <m>, <count>:`` and ``EXECUTION LEG <box>: end of
the failing lines (<run> run)``. ``<count>`` is ``<k> line(s)``, or, when a bound cut it,
``TRUNCATED to the first <k> of its <N> line(s), <s> of its <B> bytes``, and the closing line then
adds ``; TRUNCATED: <B - s> byte(s) not copied``. The command's text is the project's, read at the
commit under test as the runner and the run report are, so it is no new trust; what it prints is the
project's, and the leg reads none of it. Its status is said, never the leg's (a ``grep`` that matched
nothing exits 1). The boundary: a project that declares none, a run that passed, and a run that never
started copy nothing, and run no command; the bounds are the leg's, the same for every project; the
command's whole output is kept on the box (``$TMPDIR``) until it is copied, then removed; what the
command leaves in the worktree is the run's, as for the run report; and a stop ends it as it ends a
run.

THE HALT (ludics-lite#796). A leg reads no halt: the registry refuses new reservations and dispatch
under one, so the only records a leg can find newly dispatched there are the halt's triage owner's,
one on each box its triage names (registry.py's THE HALT'S TRIAGE). A record dispatched before the
halt keeps its legs, as it keeps its slot batches: a halt launches nothing new, and is no pause.

THE STOP (ludics-lite#767). The far side reports its shell's pid first, under this invocation's
token (``execution-leg <token>: far: <pid>``, consumed, never passed through). While the leg streams,
a SIGTERM, SIGINT or SIGHUP to it (``bg-run.sh stop`` signals the run's whole group; a Ctrl-C) ends
the far side too, where until #767 it ran on holding the worktree's lock: the leg starts ``STOP`` on
the box in a session of its own (so the stop's group signals do not cut it), which, once the pid
still carries the token, sends SIGTERM to the far shell (in its setup this ends it; during the runs
a trap defers it, and INT and HUP) and, every second for up to the far shell's grace (``graces.py``'s
FAR_SHELL: 25 s at the default input), to the far shell's ``execution slot`` or ``execution hold`` child, the wrapper, which ends the runner's process group and dies (group.py, THE
SIGNALLED WRAPPER). The far shell then winds down as after any ended run -- the control reverted,
its files removed -- even with its connection gone, since it ignores SIGPIPE once the wrapper has
returned. The leg waits up to LEG's grace (30 s at the default input) for the stop's report, then
dies of the signal it got; a second signal ends it at once. Those graces, and the wrappers' inside
them, are THE GRACES (ludics#827): each strictly longer than the one inside it, from the leg's own
``FLEET_RUNNER_GRACE``, which ``transport.FORWARDED`` gives the far side's wrappers. The boundary: only a signal the leg receives while it streams reaches the
far side. On the caller's own box the far shell runs in a session of its own, as over ssh, so a
signal aimed at the leg's group reaches it only through the stop (ludics-lite#816: until then the
group signal reached the wrapper before the far stop could see its tree, THE ESCAPED). A SIGKILL of
the leg, a dropped connection, and a box that ssh cannot reach at stop time
(``EXECUTION LEG STOP UNREACHABLE``, which prints the pid and the command that ends it there) leave
the runner running, as UNREACHABLE says. A stop in the far side's setup ends its shell, and a git
command it started finishes on its own; its private ref and staged files are left, for a later leg's
SWEEP. The stop reads ``ps`` on the box (Linux, macOS, WSL).

THE SWEEP (ludics#715). A leg's staged files (the control patch, the ``--file``) are copied to the box
before its far shell starts, so one whose ssh or bash cannot start leaves them there, and a stop or a
kill in the far side's setup leaves them and its ``refs/fleet-leg/<pid>``; nothing reads them and
they hold no lock. So each far shell, once it holds its worktree's lock, CLAIMS its own staged files
-- a shared flock on a descriptor of its own, which every process it starts inherits, the slot or
hold wrapper included, as the worktree's lock is (a claim it finds already swept refuses the leg,
nothing run) -- and then sweeps: it removes each staged file of ``$STATE/leg-control`` and
``$STATE/leg-files`` older than STAGED_GRACE (an hour) whose exclusive flock it can take, and each
``refs/fleet-leg/<pid>`` of its own ``--checkout`` whose pid is no live process on the box (this
shell's own excepted), said in one line (``swept what earlier legs left``). The age bound is not the
leg's run bound: a leg that runs for days holds its claim for as long as any process of it runs, so
the age covers only the gap from the copy to the claim -- seconds (the second copy, ssh's connect,
the far side's first checks) -- and an hour is outlived only by a file whose leg never claimed it.
The boundary, a fail-closed allowlist: regular files directly in those two directories named as the
leg names them (``<request>.<16 hex token>.<name>``, each part in ``[A-Za-z0-9._-]``), and refs
``refs/fleet-leg/<digits>``; anything else there is left. What it does not do: sweep a box no later
leg reaches, or a checkout no later leg names; remove a ref whose pid the system has given to another
process since (it waits for that process to end), or any ref when ``ps`` cannot see the far shell
itself; or stop the ``git fetch`` a stopped setup left running, which may write its ref back after the
sweep, for the next one. A file a claim misses -- one whose far shell took over an hour to reach its
first checks -- is swept, and that leg refuses (above), never runs without its patch.

THE ESCAPED (ludics-lite#816). The wrapper's group kill reaches only its group, and a runner may
leave it: OCANNL's ``tools/test-run.sh`` runs dune in a group of its own, holding the runner's
worktree lock, which its supervisor reaps on a TERM -- when the supervisor is ended first (until
ludics#827 every wrapper escalated to SIGKILL after the same 10 s grace; now one whose input
under-states the runner's reap still does), dune runs on and the next run there is
refused, "another test-run is active", until ``tools/test-run.sh stop`` reaps the group it
recorded (a stopped leg of wave-20261026, ahrefs/ocannl#1638's hand-back). So the far stop records
the wrapper's whole process tree (pid, group and ``ps -o lstart`` start time), before its SIGTERM
and every second after while the wrapper runs, and once the far shell has ended it ends what of
those trees still runs with the start time it was seen with: SIGTERM to each, and to the group it
leads (members it started since), then SIGKILL after 10 s, said on the far stop's output. What it
does not reach: a process that left the tree before the stop (a daemon that double-forked away),
one born after the last look at the tree, and a tree whose far shell still runs at the FAR_SHELL bound
(said, as before). The far shell's own processes outside the wrapper (its setup's git, the
control's revert) are not in it.
"""

import os
import re
import secrets
import select
import shlex
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from types import FrameType
from typing import Any

from ludics import cli
from ludics.fleetworker import execution, graces, revision, slot
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.preflight import knob
from ludics.fleetworker.registry import bound_commit, ref_name_ok
from ludics.fleetworker.transport import fleet_name, far_argv, is_local, prelude, put_file, substitution

USAGE = (
    "execution leg --request <id> [--box <box>] --rev <sha|branch> --checkout <dir> --worktree <dir>"
    " [--remote <name>] [--base <branch>] [--control <patch>] [--file <local file>] [--reads-no-config] [--cpu|--gpu]"
    " [--wait <seconds>] [--wait-window[=<seconds>]] [--deadline <seconds>] -- <runner command...>"
)
FILE_WORD = "{file}"  # the runner word THE FILE replaces with the shipped copy's path
DISPATCHED = ("launching", "running", "uncertain")
HEX = re.compile(r"[0-9a-fA-F]{7,}")
OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
REMOTE = re.compile(r"[A-Za-z0-9._-]+")
SECONDS = re.compile(r"[1-9][0-9]*")
WHOLE = re.compile(r"[0-9]+")
RUN_BOUND = "86400"  # each run's --deadline when the leg names none: a day, a bound only to reap with
HELD_BACK = 64  # bytes of an unfinished line kept back for the status line; it is never longer than 45

# A HINT FOR A PATH FROM ANOTHER BOX'S HOME (ludics-lite#669), appended to the far side's refusals of
# a --checkout or --worktree it cannot use. A `~` the CALLER's shell expanded arrives as that box's
# home (rog's /home/<user> at mac-studio, whose home is /Users/<user>), which expand_tilde, seeing no
# `~`, cannot undo. Its boundary, an allowlist: a path under /home/<name> or /Users/<name> whose home
# directory is neither this box's $HOME nor, physically, the directory $HOME is, and which is not
# under $HOME, gets the hint; any other path, and a box with no $HOME, gets none (empty output). It
# says why only as a question: another user's home on this box is the same shape.
NOT_HOME = r"""not_home() {
  local rest name top here
  case "$1" in /home/?*|/Users/?*) ;; *) return 0 ;; esac
  [ -n "${HOME:-}" ] || return 0
  case "$1" in "${HOME%/}"|"${HOME%/}"/*) return 0 ;; esac
  rest=${1#/*/}; name=${rest%%/*}; [ -n "$name" ] || return 0
  top="${1%%/"$rest"}/$name"
  here=$(cd "$HOME" 2>/dev/null && pwd -P) || here=${HOME%/}
  [ -d "$top" ] && [ "$(cd "$top" 2>/dev/null && pwd -P)" = "$here" ] && return 0
  printf "; %s is not %s's home directory (%s): a ~ expanded by the caller's shell? spell far-side paths absolutely, or quote '~/...'" "$top" "$BOX" "$HOME"
}
"""

# THE BACKEND PIN (see the header), one parser for every reader of .github/fleet-leg (the leg here,
# `execution tip-run`'s GPU-loop check, ludics-lite#793). Bash 3.2: no arrays of its own, no case
# conversion. Each function prints why (one line, no prefix) and returns 1 when it refuses.
#   fleet_leg_read <checkout> <sha>: prints the file's text at <sha> (exit 0), nothing (exit 2) when
#     <sha> has none, or why it is unreadable (exit 1: git failed, or a NUL byte, which a shell
#     variable would drop, making a binary file read as one with no pins).
#   backend_pin <file text> <gpu: 0|1> <runner argv...>: exit 0 when the leg may run. The file is
#     parsed whatever the leg declares, so a line this version cannot read refuses a --cpu leg too.
#   backend_pin_to <file text> <backend> <runner argv...>: exit 0 only when the argv pins <backend>
#     and nothing else -- every pin it satisfies names exactly <backend> -- and the file names a pin.
# pin_grammar and pin_scan set the caller's locals (bash scopes dynamically): pin_flags, pin_envs and
# pin_asks (the file's pins, the asks with `<backend>` for the value), pin_plan (its slot-plan path,
# or empty), pin_floor (its floor, or empty), pin_report (its run-report path, or empty), pin_fail
# (its fail-lines command, or empty),
# and pin_any (a pin the argv satisfies) and pin_other (the first one naming another backend
# than pin_target, as `<how>`).
PIN = r"""fleet_leg_read() {
  local co="$1" sha="$2" text
  [ "$(git -C "$co" cat-file -t "$sha:.github/fleet-leg" 2>/dev/null)" = blob ] || return 2
  text=$(git -C "$co" cat-file blob "$sha:.github/fleet-leg") || { printf '%s' "cannot read .github/fleet-leg at $sha in $co (above)"; return 1; }
  [ "$(git -C "$co" cat-file blob "$sha:.github/fleet-leg" | tr -d '\000' | wc -c)" -eq "$(git -C "$co" cat-file -s "$sha:.github/fleet-leg")" ] ||
    { printf '%s' ".github/fleet-leg at $sha holds NUL bytes, which the fleet does not read"; return 1; }
  printf '%s' "$text"
}
pin_grammar() {
  local text="$1" raw d w extra good n=0 sp cr
  sp=" $(printf '\t')" cr=$(printf '\r')
  pin_flags="" pin_envs="" pin_asks="" pin_plan="" pin_report="" pin_floor="" pin_fail=""
  while IFS= read -r raw || [ -n "$raw" ]; do
    n=$((n + 1))
    d="" w="" extra=""
    read -r d w extra <<<"$raw"
    case "$d" in ''|'#'*) continue ;; esac
    good=""
    case "$d" in
      pin-flag) case "$w" in -*[!A-Za-z0-9_.-]*|-|--) ;; -*) good=1 ;; esac ;;
      pin-env) case "$w" in *[!A-Za-z0-9_]*|[0-9]*|'') ;; *) good=1 ;; esac ;;
      # A path in the worktree: relative, no `..` or `.` component, no empty one, not an option.
      slot-plan) case "$w" in ''|/*|-*|*[!A-Za-z0-9_./-]*|*//*|*/|.|..|./*|../*|*/./*|*/../*|*/.|*/..) ;; *) [ -n "$pin_plan" ] || good=1 ;; esac ;;
      min-free-gib) case "$w" in ''|*[!0-9]*) ;; *) [ -n "$pin_floor" ] || good=1 ;; esac ;;
      run-report) case "$w" in ''|/*|-*|*[!A-Za-z0-9_./-]*|*//*|*/|.|..|./*|../*|*/./*|*/../*|*/.|*/..) ;; *) [ -n "$pin_report" ] || good=1 ;; esac ;;
      # THE FAILING LINES: the rest of the line, as written, is one shell command (no CR, as no
      # other line takes one).
      fail-lines) case "$raw" in *"$cr"*) ;; *) [ -n "$w" ] && [ -z "$pin_fail" ] && good=1 extra="" ;; esac ;;
    esac
    if [ -z "$good" ] || [ -n "$extra" ]; then
      printf '%s' ".github/fleet-leg line $n is not one the fleet reads ($d${w:+ $w}${extra:+ $extra}): pin-flag <option>, pin-env <NAME>, one slot-plan <path in the worktree>, one run-report <path in the worktree>, one fail-lines <shell command>, one min-free-gib <GiB>, a # comment or a blank line"
      return 1
    fi
    case "$d" in
      pin-flag) pin_flags="$pin_flags $w"; pin_asks="$pin_asks, $w <backend>" ;;
      pin-env) pin_envs="$pin_envs $w"; pin_asks="$pin_asks, env $w=<backend>" ;;
      slot-plan) pin_plan=$w ;;
      run-report) pin_report=$w ;;
      min-free-gib) pin_floor=$w ;;
      # The line less its leading blanks, the key, the blanks after it and its trailing blanks.
      fail-lines) pin_fail=${raw#"${raw%%[!$sp]*}"}; pin_fail=${pin_fail#fail-lines}; pin_fail=${pin_fail#"${pin_fail%%[!$sp]*}"}
        pin_fail=${pin_fail%"${pin_fail##*[!$sp]}"} ;;
    esac
  done <<FLEET_LEG_PIN
$text
FLEET_LEG_PIN
  pin_asks=${pin_asks#, }
}
# A value the argv pins: counted, and compared with pin_target when there is one.
pin_seen() {
  pin_any=1
  [ -z "$pin_target" ] || [ -n "$pin_other" ] || [ "$1" = "$pin_target" ] || pin_other="$2"
}
pin_scan() {
  local a f prev first cmd
  if [ -n "$pin_envs" ] && [ "${1##*/}" = env ]; then
    # Each NAME's value is its LAST assignment among those after `env` (empty ones included), as env
    # applies them: `NAME=cuda NAME=` leaves it empty. A command must follow them: a bare `env
    # NAME=cuda` runs no runner, only prints the environment, and exits 0. Any word holding a `=` is
    # an assignment to env (GNU env takes `1=x` as one), so the command is the first word without.
    for f in $pin_envs; do
      first=1; prev=""; cmd=""
      for a in "$@"; do
        if [ -n "$first" ]; then first=""; continue; fi
        case "$a" in *=*) ;; *) cmd=1; break ;; esac
        case "$a" in "$f="*) prev=${a#*=} ;; esac
      done
      [ -z "$prev" ] || [ -z "$cmd" ] || pin_seen "$prev" "$f=$prev"
    done
  fi
  first=1; prev=""
  for a in "$@"; do
    if [ -n "$first" ]; then first=""; continue; fi
    [ "$a" != -- ] || break
    [ -z "$prev" ] || [ -z "$a" ] || pin_seen "$a" "$prev $a"
    prev=""
    for f in $pin_flags; do
      [ "$a" != "$f" ] || prev=$f
      case "$a" in "$f="?*) pin_seen "${a#*=}" "$a" ;; esac
    done
  done
}
backend_pin() {
  local text="$1" gpu="$2" pin_flags pin_envs pin_asks pin_plan pin_report pin_floor pin_fail pin_any="" pin_other="" pin_target="" hint="" e
  shift 2
  pin_grammar "$text" || return 1
  [ "$gpu" = 1 ] && [ -n "$pin_flags$pin_envs" ] || return 0
  pin_scan "$@"
  [ -z "$pin_any" ] || return 0
  # A shell's -c string is one word to this reader: say the form that carries the pin outside it.
  case "${1##*/}" in
    sh|bash|dash|zsh|ksh)
      case "${2:-}" in
        --*) ;;
        -*c*)
          if [ -n "$pin_envs" ]; then
            for e in $pin_envs; do break; done
            hint="; a pin inside a ${1##*/} -c string is no word of the argv: lead with it, env $e=<backend> ${1##*/} -c '...', or give the runner a long list as a file, --file <local file> and the runner word {file}"
          else
            hint="; a pin inside a ${1##*/} -c string is no word of the argv: run the runner itself, its pin among its words, and give it a long list as a file, --file <local file> and the runner word {file}"
          fi ;;
      esac ;;
  esac
  printf '%s' "this leg may hold the GPU (no --cpu), but its runner pins no backend, and .github/fleet-leg asks for one of: $pin_asks; pin it (as words of the runner's own argv)$hint; or declare --cpu for a leg that holds no GPU, or --reads-no-config for a runner that reads none of the project's configuration"
  return 1
}
backend_pin_to() {
  local text="$1" pin_target="$2" pin_flags pin_envs pin_asks pin_plan pin_report pin_floor pin_fail pin_any="" pin_other=""
  shift 2
  pin_grammar "$text" || return 1
  if [ -z "$pin_flags$pin_envs" ]; then
    printf '%s' "this run is the $pin_target backend's, but .github/fleet-leg names no pin-flag or pin-env, so whether its command selects $pin_target cannot be checked"
    return 1
  fi
  pin_scan "$@"
  if [ -z "$pin_any" ]; then
    printf '%s' "this run is the $pin_target backend's, but its command pins no backend, and .github/fleet-leg asks for one of: $pin_asks; pin $pin_target (as words of the command's own argv)"
    return 1
  fi
  [ -z "$pin_other" ] || { printf '%s' "this run is the $pin_target backend's, but its command pins another ($pin_other)"; return 1; }
}
"""

# THE SWEEP (ludics#715, see the header). A staged file's claim must be taken within this many seconds
# of its copy: the --file's copy, ssh's connect (ConnectTimeout=15) and the far side's first checks
# come between, so an hour is a bound only a file whose leg never started outlives.
STAGED_GRACE = 3600
# What the sweep reads, a fail-closed allowlist: regular files directly in $STATE/leg-control and
# $STATE/leg-files named as run_leg names them (<request>.<16 hex token>.<name>, each part in
# [A-Za-z0-9._-]), and refs refs/fleet-leg/<digits> of the leg's own --checkout. Anything else there
# is not the fleet's and is left alone.
SWEEP_PY = r"""import fcntl, os, re, stat, sys, time
state, grace, own = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
# The claim: a shared flock on each of this leg's own files, through the descriptor the far shell
# opened, and the file still at its path (a sweep that won the race unlinked it): else exit 3.
for fd, path in zip(own[0::2], own[1::2]):
    try:
        fcntl.flock(int(fd), fcntl.LOCK_SH | fcntl.LOCK_NB)
        mine, there = os.fstat(int(fd)), os.stat(path)
    except OSError:
        sys.exit(3)
    if (mine.st_dev, mine.st_ino) != (there.st_dev, there.st_ino):
        sys.exit(3)
named = re.compile(r"[A-Za-z0-9._-]+\.[0-9a-f]{16}\.[A-Za-z0-9._-]+")
now = time.time()
for sub in ("leg-control", "leg-files"):
    where = os.path.join(state, sub)
    try:
        names = sorted(os.listdir(where))
    except OSError:
        continue
    for name in names:
        path = os.path.join(where, name)
        try:
            st = os.lstat(path)
            if not named.fullmatch(name) or not stat.S_ISREG(st.st_mode) or now - st.st_mtime < grace:
                continue
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            continue
        try:
            # Claimed: its leg, or a process it started, still holds it.
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            held, there = os.fstat(fd), os.lstat(path)
            if (held.st_dev, held.st_ino) == (there.st_dev, there.st_ino):
                os.unlink(path)
                print(path)
        except OSError:
            pass
        finally:
            os.close(fd)
"""
SWEEP = (f"STAGED_GRACE={STAGED_GRACE}\nSWEEP_PY={shlex.quote(SWEEP_PY)}\n" + r"""# sweep_staged <checkout> [<fd> <path>]...: claim this leg's own staged files (exit 3 when one was
# lost), then remove the stale ones earlier legs left; each path or ref removed on stdout.
sweep_staged() {
  local co="$1" r p
  shift
  "$SKILLS_REPO/scripts/py" -c "$SWEEP_PY" "$STATE" "$STAGED_GRACE" "$@" </dev/null || return
  # A private ref whose far shell is no live process on this box: nothing will read it. A ps that
  # cannot see this shell sees no process, so it sweeps no ref.
  ps -p "$$" >/dev/null 2>&1 || return 0
  git -C "$co" for-each-ref --format='%(refname)' refs/fleet-leg/ 2>/dev/null | while IFS= read -r r; do
    p=${r#refs/fleet-leg/}
    case "$p" in ''|*[!0-9]*) continue ;; esac
    [ "$p" != "$$" ] || continue
    if ps -p "$p" >/dev/null 2>&1; then continue; fi
    git -C "$co" update-ref -d "$r" >/dev/null 2>&1 && printf '%s\n' "$r"
  done
  return 0
}
""")

# What every far side that judges a leg's worktree shares (this verb, `farside-close`): one reading
# of what the checkout is and is holding, and above all ONE LOCK. A second spelling of the lock's key
# would name another file, and a close-out would remove a worktree a leg still runs in.
#   common <path>, gitdir <path>: its git common directory, its git directory, physical; empty when
#     it is no checkout. A failed `git rev-parse` stops them before the `cd` that makes its answer
#     absolute: bash 3.2's `cd ""` succeeds and stays put, so a plain directory would read as its own.
#   dirt <path>: what makes a worktree not the commit at its HEAD: changed, staged or untracked paths
#     and submodules, whatever the configuration says to show or ignore; git's own failure is its
#     status, never an empty (clean) answer.
#   canon <path>: the nearest existing ancestor's physical path, then the rest as given, so a leg
#     before the worktree exists and one after it name the same lock.
#   leg_lock_file <canon's output>, leg_flock: the lock's file, and a flock on descriptor 9 (exit 3:
#     held; the caller opens the descriptor, so a refusal can name a failed open). A flock belongs to
#     the open file, so it holds until the last process that inherited it has exited. Taken by
#     scripts/py (Python >= 3.12, which `execution slot` needs on the box anyway), since macOS has no
#     flock(1).
WORKTREE = r"""common() { (cd "$1" 2>/dev/null && d=$(git rev-parse --git-common-dir 2>/dev/null) && cd "$d" 2>/dev/null && pwd -P); }
gitdir() { (cd "$1" 2>/dev/null && d=$(git rev-parse --git-dir 2>/dev/null) && cd "$d" 2>/dev/null && pwd -P); }
dirt() { git -C "$1" status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null; }
canon() {
  local p="$1" rest="" base
  while [ ! -d "$p" ] && [ "$p" != / ] && [ "$p" != . ]; do rest="/$(basename "$p")$rest"; p=$(dirname "$p"); done
  base=$(cd "$p" && pwd -P) || return 1
  printf '%s%s' "${base%/}" "$rest"
}
leg_lock_file() { printf '%s' "$STATE/leg-locks/$(printf '%s' "$1" | cksum | tr ' ' -)"; }
leg_flock() {
  "$SKILLS_REPO/scripts/py" -c 'import fcntl, sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(3)' </dev/null
}
"""

# THE FREE-SPACE FLOOR (see the header), this verb's far side's and `tip-run`'s. Args: the floor in GiB,
# the paths. Prints `<GiB free> <path>` for the path with the least free; exit 3 when that is under the
# floor, 1 with nothing printed when one cannot be read.
FLOOR_PY = r"""import os, shutil, sys
floor, paths = int(sys.argv[1]), sys.argv[2:]
def room(path):
    while path and not os.path.exists(path):
        path = os.path.dirname(path)
    return shutil.disk_usage(path).free
try:
    least, where = min((room(path), path) for path in paths)
except OSError:
    sys.exit(1)
print(f"{least // 2**20 / 1024:.2f} {where}")
sys.exit(3 if least < floor * 2**30 else 0)
"""
FLOOR = f"FLOOR_PY={shlex.quote(FLOOR_PY)}\n"

# THE BASE (see the header). refresh_base <checkout> <remote> <branch or empty> <bound in seconds>
# [<how>]: fetch the base branch into its remote-tracking ref, `refs/remotes/<remote>/<branch>`, the
# branch `--base` names or, with none, the one `refs/remotes/<remote>/HEAD` names in the checkout.
# `execution tip-run` runs it too (tiprun.py, THE BASE), naming the flag a named branch came from
# as <how> (default `--base`). git's own words go to stderr; one line on stdout, `<branch> <how> <old>
# <sha>` (how: that flag or `<remote>/HEAD`; old: the ref's commit before the fetch or `unset`; sha:
# after it, or `-` when the fetch did not land). Exit 0 fetched, 3 no base to fetch (no branch named
# and no `<remote>/HEAD`), 124 the bound reached, else git's failure, after one retry a second later (a
# concurrent fetch of the same ref in this checkout holds its lock for a moment). The leg runs it
# without the worktree lock's descriptor, as the revision's fetch is run.
BASE = r"""refresh_base() {
  local co="$1" remote="$2" base="$3" bound="$4" how="${5:---base}" head old sha=- rc tries=0
  if [ -z "$base" ]; then
    head=$(git -C "$co" symbolic-ref -q "refs/remotes/$remote/HEAD" 2>/dev/null) || return 3
    case "$head" in "refs/remotes/$remote/"?*) base=${head#"refs/remotes/$remote/"} ;; *) return 3 ;; esac
    how="$remote/HEAD"
  fi
  old=$(git -C "$co" rev-parse -q --verify "refs/remotes/$remote/$base^{commit}" 2>/dev/null) || old=unset
  while :; do
    bounded "$bound" env GIT_TERMINAL_PROMPT=0 git -C "$co" fetch -q --no-tags "$remote" "+refs/heads/$base:refs/remotes/$remote/$base" >&2; rc=$?
    [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && [ "$tries" -eq 0 ] || break
    tries=1; sleep 1
  done
  [ "$rc" -ne 0 ] || sha=$(git -C "$co" rev-parse -q --verify "refs/remotes/$remote/$base^{commit}" 2>/dev/null) || { sha=-; rc=1; }
  printf '%s %s %s %s\n' "$base" "$how" "$old" "$sha"
  return "$rc"
}
"""

# The far side, after the prelude. Args: checkout, worktree, remote, rev, want (the assigned commit or
# empty), patch name (in $STATE/leg-control, or empty), request id, the fetch's bound in seconds
# (FLEET_FETCH_TIMEOUT), the status token (see the header), the shipped --file's name (in
# $STATE/leg-files, or empty), the --reads-no-config declaration (0|1), the free-space floor in GiB
# (FLEET_LEG_MIN_FREE_GIB, 0 for none), the --base branch (or empty), the wrapper's word count and words
# (fleet-worker.sh's own verb and flags, ending before its `--`), each run's nested-slot flags'
# count and words, then the runner's argv.
LEG = NOT_HOME + PIN + SWEEP + WORKTREE + FLOOR + BASE + r"""co=$(expand_tilde "$1") wt=$(expand_tilde "$2") remote="$3" rev="$4" want="$5" pname="$6" request="$7" fetch_timeout="$8" token="$9" fname="${10}" no_config="${11}" min_free="${12}" base="${13}" nwrap="${14}"
# THE STOP (see the header): this shell's pid, first, under the token; the leg keeps it.
printf 'execution-leg %s: far: %s\n' "$token" "$$"
shift 14
fw="$SKILLS_REPO/issue-wave/scripts/fleet-worker.sh"
wrap=("$fw")
while [ "$nwrap" -gt 0 ]; do wrap+=("$1"); shift; nwrap=$((nwrap - 1)); done
nnest="$1"; shift; nest=()
while [ "$nnest" -gt 0 ]; do nest+=("$1"); shift; nnest=$((nnest - 1)); done
patch=""; [ -z "$pname" ] || patch="$STATE/leg-control/$pname"
lfile=""; [ -z "$fname" ] || lfile="$STATE/leg-files/$fname"
ref="refs/fleet-leg/$$"; results=""; planned=""
say() { printf 'EXECUTION LEG %s: %s\n' "$BOX" "$*" >&2; }
cleanup() {
  [ -z "$patch" ] || rm -f "$patch"
  [ -z "$lfile" ] || rm -f "$lfile"
  [ -z "$planned" ] || rm -f "$planned"
  [ -z "$results" ] || rm -f "$results" "$results.sh" "$results.report" "$results.fail" "$results.fail.shown"
  git -C "$co" update-ref -d "$ref" >/dev/null 2>&1
  return 0
}
refuse() { printf 'EXECUTION LEG REFUSED %s: %s\n' "$BOX" "$*" >&2; cleanup; exit 1; }
finish() { cleanup; printf 'execution-leg %s: exit: %s\n' "$token" "$1"; exit "$1"; }
[ -x "$fw" ] || refuse "no executable fleet-worker.sh at $fw (the skills checkout on $BOX; run fleet-worker.sh refresh $BOX)"
cdir=$(common "$co"); [ -n "$cdir" ] || refuse "--checkout $co is not a git checkout on $BOX$(not_home "$co")"
# One leg at a time in a worktree, from the status check through the control's revert: a second
# leg moving it would make the first test another commit than the observed_sha it reports. The lock
# (WORKTREE) is taken on descriptor 9 of this shell, which every process started from here inherits
# -- the slot or hold wrapper included, which stays the parent of the runner's group for as long as
# any of it runs -- so this shell dying while the runner runs on (a dropped connection) does not free
# the worktree.
wkey=$(canon "$wt") || refuse "cannot resolve --worktree $wt on $BOX$(not_home "$wt")"
# An explicit site floor can be checked before fetching the project config.
check_floor() {
if [ "$min_free" != 0 ]; then
  room=$("$SKILLS_REPO/scripts/py" -c "$FLOOR_PY" "$min_free" "$co" "$wkey" </dev/null 2>/dev/null); frc=$?
  [ "$frc" -ne 3 ] || refuse "only ${room%% *} GiB free on the filesystem of ${room#* }, under the floor of $min_free GiB (FLEET_LEG_MIN_FREE_GIB); nothing ran: free space there first (fleet-worker.sh farside-close <wave> removes a closed wave's far-side worktrees), or lower the knob for a run that fits"
  [ "$frc" -eq 0 ] || say "NOTE: cannot read the free space of $co or $wt (exit $frc), so the floor of $min_free GiB (FLEET_LEG_MIN_FREE_GIB) is not checked; the leg goes on"
fi
}
[ -z "$min_free" ] || check_floor
mkdir -p "$STATE/leg-locks" || refuse "cannot create $STATE/leg-locks on $BOX"
wlock=$(leg_lock_file "$wkey")
exec 9>>"$wlock" || refuse "cannot open the worktree lock $wlock on $BOX"
leg_flock; lrc=$?
[ "$lrc" -ne 3 ] || refuse "--worktree $wt: another leg is using it (lock $wlock); wait for it, or name another worktree"
[ "$lrc" -eq 0 ] || refuse "cannot lock --worktree $wt ($SKILLS_REPO/scripts/py exit $lrc, above)"
# THE SWEEP (see the header): this leg's own staged files claimed, on descriptors every process
# started from here inherits, as the worktree's lock is; then what earlier legs left is removed.
own=()
if [ -n "$patch" ]; then exec 7<"$patch" || refuse "the control patch did not arrive at $patch"; own+=(7 "$patch"); fi
if [ -n "$lfile" ]; then exec 6<"$lfile" || refuse "the --file did not arrive at $lfile"; own+=(6 "$lfile"); fi
swept=$(sweep_staged "$co" ${own[@]+"${own[@]}"}); src=$?
[ "$src" -ne 3 ] || refuse "this leg's staged files were swept as stale before it claimed them (they waited over ${STAGED_GRACE}s for the leg to start); nothing ran"
[ "$src" -eq 0 ] || refuse "cannot claim this leg's staged files or sweep stale ones ($SKILLS_REPO/scripts/py exit $src, above); nothing ran"
[ -z "$swept" ] || say "swept what earlier legs left (ludics#715): $(printf '%s' "$swept" | tr '\n' ' ')"
# The commit, into a private ref of the checkout (never FETCH_HEAD: see the module header).
case "$rev" in *[!0-9a-f]*) sha_like=0 ;; *) case ${#rev} in 40|64) sha_like=1 ;; *) sha_like=0 ;; esac ;; esac
if [ "$sha_like" = 1 ] && git -C "$co" cat-file -e "$rev^{commit}" 2>/dev/null; then
  sha=$rev how="already in $co"
else
  # A branch is named as one (refs/heads/...): an unqualified source would take a tag of the same
  # name first. A SHA is fetched as itself.
  src=$rev; [ "$sha_like" = 1 ] || src="refs/heads/$rev"
  # Without the worktree lock's descriptor: a transport process the bound outlives (a stalled
  # upload-pack's child) must not hold the worktree for the next leg.
  # (A subshell's `exec 9>&-`, not a redirection on the call, which bash keeps a saved copy of.)
  ( exec 9>&-; bounded "$fetch_timeout" env GIT_TERMINAL_PROMPT=0 git -C "$co" fetch -q --no-tags "$remote" "+$src:$ref" >&2 ); frc=$?
  [ "$frc" -ne 124 ] || refuse "git fetch $remote $rev in $co did not finish in ${fetch_timeout}s (FLEET_FETCH_TIMEOUT)"
  [ "$frc" -eq 0 ] || refuse "git fetch $remote $rev in $co failed (above): no such branch or commit on $remote, or $remote is unreachable from $BOX"
  sha=$(git -C "$co" rev-parse --verify -q "$ref^{commit}") || refuse "$rev fetched from $remote is not a commit"
  [ "$sha_like" = 0 ] || [ "$sha" = "$rev" ] || refuse "fetching $rev from $remote gave $sha"
  how="fetched from $remote"
fi
[ -z "$want" ] || [ "$sha" = "$want" ] ||
  refuse "$rev is $sha, but request $request was assigned $want: run --rev $want (a rebase since? its coordinator can rebind $request to the new head: execution rebind, ludics#829)"
# THE BASE (see the header): the branch the project's reach diffs against, fetched into its
# remote-tracking ref, so the runner in the worktree reads <remote>/<branch> as the remote has it now.
binfo=$( exec 9>&-; refresh_base "$co" "$remote" "$base" "$fetch_timeout" ); brc=$?
read -r bname bhow bold bsha <<<"$binfo"
case $brc in
  0) say "base $remote/$bname at $bsha ($bhow), fetched from $remote before the run; was $bold" ;;
  3) say "WARNING: no base fetched: $co has no $remote/HEAD and the leg names no --base, so a runner that diffs against a branch of $remote reads it as $co last fetched it; name the project's base with --base <branch>" ;;
  124) refuse "git fetch $remote $bname (the base, $bhow) in $co did not finish in ${fetch_timeout}s (FLEET_FETCH_TIMEOUT); a runner diffing against $remote/$bname would read it stale (ludics#1042), so nothing ran" ;;
  *) refuse "git fetch $remote $bname (the base, $bhow) in $co failed (above), retried once: no such branch on $remote, or $remote is unreachable from $BOX; a runner diffing against $remote/$bname would read it stale (ludics#1042), so nothing ran" ;;
esac
# THE BACKEND PIN (see the header): the project's rule at this commit, before the worktree moves.
pins=$(fleet_leg_read "$co" "$sha"); prc=$?
[ "$prc" -ne 1 ] || refuse "$pins; nothing ran"
pin_plan="" pin_report="" pin_floor="" pin_fail=""
if [ "$prc" -eq 0 ]; then
  case " ${nest[*]} " in *" --cpu "*) gpu=0 ;; *) gpu=1 ;; esac
  # --reads-no-config: the caller declares a runner that reads none of the project's configuration, so no
  # pin is asked of it; the file is still read, and a line this version cannot read still refuses.
  [ "$no_config" != 1 ] || gpu=0
  why=$(backend_pin "$pins" "$gpu" "$@") || refuse "$why (.github/fleet-leg at $sha); nothing ran"
  pin_grammar "$pins"
  [ "$no_config" != 1 ] || say "--reads-no-config: the runner is declared to read none of the project's configuration, so no backend pin was asked of it (.github/fleet-leg at $sha); its result is no backend's evidence"
fi
# With no site override, select the project floor (or default) only after parsing the config.
if [ -z "$min_free" ]; then
  min_free=${pin_floor:-20}
  check_floor
fi
# The worktree: a linked worktree of the checkout, made or moved to the commit, never overwritten.
if [ -e "$wt" ] || [ -L "$wt" ]; then
  [ -d "$wt" ] || refuse "--worktree $wt exists and is not a directory"
  [ "$(common "$wt")" = "$cdir" ] || refuse "--worktree $wt exists but is not a worktree of $co; name a new path, or a worktree of that checkout"
  top=$(cd "$wt" && git rev-parse --show-toplevel 2>/dev/null)
  [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(cd "$wt" && pwd -P)" ] || refuse "--worktree $wt is inside a worktree, not its top"
  [ "$(gitdir "$wt")" != "$cdir" ] || refuse "--worktree $wt is the repository's main checkout; a leg moves only a linked worktree"
  [ "$(cd "$wt" && pwd -P)" != "$(cd "$co" && pwd -P)" ] || refuse "--worktree $wt is --checkout $co itself; a leg moves only another worktree"
  dirty=$(dirt "$wt") || refuse "cannot read the status of $wt"
  [ -z "$dirty" ] || refuse "--worktree $wt has uncommitted changes ($(printf '%s\n' "$dirty" | grep -c '') path(s)), which a leg never overwrites: clean it, or name another worktree"
  git -C "$wt" checkout -q --detach "$sha" </dev/null >&2 || refuse "git checkout --detach $sha in $wt failed (above)"
  made=refreshed
else
  git -C "$co" worktree prune >/dev/null 2>&1
  git -C "$co" worktree add -q --detach "$wt" "$sha" </dev/null >&2 || refuse "git worktree add --detach $wt $sha in $co failed (above)$(not_home "$wt")"
  made=created
fi
head=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}') || refuse "cannot read HEAD of $wt"
[ "$head" = "$sha" ] || refuse "HEAD of $wt is $head after checking out $sha"
# Clean at the commit, submodules included: a submodule the checkout moved past is refused, never
# updated, since the runner would test its old commit under this one's observed_sha.
dirty=$(dirt "$wt") || refuse "cannot read the status of $wt"
[ -z "$dirty" ] || refuse "$wt is not clean at $sha ($(printf '%s\n' "$dirty" | head -n 3 | tr '\n' ';')): a submodule that does not follow the checkout, or a file it left; a leg updates no submodule"
git -C "$co" update-ref -d "$ref" >/dev/null 2>&1
if [ -n "$patch" ]; then
  [ -f "$patch" ] || refuse "the control patch did not arrive at $patch"
  git -C "$wt" apply --check "$patch" >&2 || refuse "the control patch does not apply to $sha in $wt (above)"
fi
# THE FILE (see the header): each runner word that is exactly {file} becomes the shipped copy's path.
if [ -n "$lfile" ]; then
  [ -f "$lfile" ] || refuse "the --file did not arrive at $lfile"
  words=()
  for a in "$@"; do if [ "$a" = '{file}' ]; then words+=("$lfile"); else words+=("$a"); fi; done
  set -- "${words[@]}"
fi
say "$made $wt at $sha ($rev, $how) for request $request; observed_sha=$head"
[ -z "$lfile" ] || say "--file shipped as $lfile, the runner's {file}"
# THE SLOT PLAN (see the header): a correctness leg that names neither --cpu nor --gpu, in a project
# whose .github/fleet-leg names a slot-plan, asks it whether the runs hold the GPU. The plan runs
# here, in the worktree at the commit, under a slot of its own taken --cpu with the leg's slot flags
# and each run's bound; only its exit 0 with `cpu` as its last stdout line makes the runs --cpu.
# Anything else leaves the leg's slot as given (it may hold the GPU: the fail-closed default), said.
if [ -n "$pin_plan" ] && [ "${wrap[2]}" = slot ] && case " ${nest[*]} " in *" --cpu "*|*" --gpu "*) false ;; *) true ;; esac; then
  planned=$(mktemp "${TMPDIR:-/tmp}/fleet-leg-plan.XXXXXX") || refuse "cannot create a scratch file on $BOX"
  stop_asked=""
  trap 'stop_asked=1' TERM INT HUP
  if [ -f "$wt/$pin_plan" ] && [ -x "$wt/$pin_plan" ]; then
    # In this shell, not a subshell: the wrapper must be its child, which THE STOP ends.
    here=$PWD
    cd "$wt" || refuse "cannot enter $wt for the slot plan"
    fleet_worker "${wrap[@]}" --cpu "${nest[0]}" "${nest[1]}" -- "./$pin_plan" "$@" </dev/null >"$planned"; plrc=$?
    cd "$here" || cd / || refuse "cannot leave $wt after the slot plan"
  else
    printf 'no executable %s in %s\n' "$pin_plan" "$wt" >&2; plrc=127
  fi
  trap - TERM INT HUP
  [ -z "$stop_asked" ] || refuse "stopped during the slot plan (exit $plrc); nothing ran"
  cat "$planned" >&2
  kind=$(sed '/^[[:space:]]*$/d' "$planned" | tail -n 1)
  rm -f "$planned"; planned=""
  now=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)
  [ "$now" = "$head" ] || refuse "the slot plan $pin_plan moved HEAD of $wt to ${now:-unreadable}, not $head; nothing ran"
  dirty=$(dirt "$wt") || refuse "cannot read the status of $wt after the slot plan"
  [ -z "$dirty" ] || refuse "the slot plan $pin_plan left $wt not clean at $head ($(printf '%s\n' "$dirty" | head -n 3 | tr '\n' ';')); nothing ran"
  if [ "$plrc" -eq 0 ] && [ "$kind" = cpu ]; then
    wrap+=(--cpu); nest+=(--cpu)
    say "slot plan $pin_plan (.github/fleet-leg at $sha): cpu, so the runs take their slot --cpu"
  elif [ "$plrc" -eq 0 ] && [ "$kind" = gpu ]; then
    say "slot plan $pin_plan (.github/fleet-leg at $sha): gpu, so the runs take a slot that may hold the GPU"
  else
    say "WARNING: slot plan $pin_plan (.github/fleet-leg at $sha) named no kind (exit $plrc, last line: ${kind:-none}; it prints cpu or gpu last): the runs take a slot that may hold the GPU, as given"
  fi
fi
results=$(mktemp "${TMPDIR:-/tmp}/fleet-leg.XXXXXX") || refuse "cannot create a scratch file on $BOX"
# The runs, under ONE slot (or the measurement's hold): the main run, then the control. Each step
# that ends is written to the results file, so a wrapper that refused is told from a runner that ran.
# The script is a file beside it, so the slot's "held for" line names it rather than quoting it.
# Each run is a nested `execution slot --deadline` (inside the enclosing slot or hold, taking none
# of its own): with a deadline it leads a process group of its own, and a command that ends first
# takes anything it left running in that group with it (group.py, ludics-lite#566), so a runner's
# leftover background child cannot overlap the control run, nor outlive the leg.
cat > "$results.sh" <<'FLEET_LEG_RUNS' || refuse "cannot write a scratch file on $BOX"
wt="$1" patch="$2" results="$3" box="$4" fw="$5" head="$6" report="$7" fail="$8" n="$9"; shift 9
nest=(); while [ "$n" -gt 0 ]; do nest+=("$1"); shift; n=$((n - 1)); done
cd "$wt" || exit 1
# THE RUN REPORT (see the header): after a run that started, the project's report, in its own nested
# slot (300 s), stdout and stderr together, its last 200 lines on stderr
# between two lines that say whose it is. Its status is said, never the leg's.
said() {
  local tag="$1" rc="$2" out n rrc
  shift 2
  [ -n "$report" ] && grep -qx "$tag-started" "$results" || return 0
  out="$results.report"
  if [ -f "$report" ] && [ -x "$report" ]; then
    # The report's stderr joins its stdout inside the slot, whose own lines stay on stderr, outside it.
    "$fw" execution slot --deadline 300 "${nest[@]:2}" -- bash -c 'exec "$0" "$@" 2>&1' "./$report" "$@" </dev/null >"$out"; rrc=$?
  else
    printf "no executable %s in %s\n" "$report" "$wt" >"$out"; rrc=127
  fi
  n=$(grep -c "" "$out")
  if [ "$n" -gt 200 ]; then n="the last 200 of its $n lines"; else n="$n line(s)"; fi
  printf "EXECUTION LEG %s: run report %s after the %s run (exit %s), report exit %s, %s:\n" "$box" "$report" "$tag" "$rc" "$rrc" "$n" >&2
  tail -n 200 "$out" >&2
  printf "EXECUTION LEG %s: end of the run report (%s run)\n" "$box" "$tag" >&2
  rm -f "$out"
}
# THE FAILING LINES (see the header): after a run that started and FAILED, the project's fail-lines
# command, in its own nested slot (300 s), stdout and stderr together, the runner's argv its $1...;
# its first 16384 bytes, and of those its first 100 lines, on stderr between two lines that say
# whose they are and, when it is cut, how much was not copied. Its status is said, never the leg's.
failing() {
  local tag="$1" rc="$2" out n b sn sb frc cut="" left=""
  shift 2
  [ -n "$fail" ] && [ "$rc" -ne 0 ] && grep -qx "$tag-started" "$results" || return 0
  out="$results.fail"
  # The command's stderr joins its stdout inside the slot, whose own lines stay on stderr, outside it.
  "$fw" execution slot --deadline 300 "${nest[@]:2}" -- bash -c 'exec bash -c "$0" fail-lines "$@" 2>&1' "$fail" "$@" </dev/null >"$out"; frc=$?
  head -c 16384 "$out" | head -n 100 >"$out.shown"
  n=$(grep -c "" "$out"); b=$(wc -c <"$out" | tr -d " ")
  sn=$(grep -c "" "$out.shown"); sb=$(wc -c <"$out.shown" | tr -d " ")
  if [ "$sb" -lt "$b" ]; then
    cut="TRUNCATED to the first $sn of its $n line(s), $sb of its $b bytes"
    left="; TRUNCATED: $((b - sb)) byte(s) not copied"
  else
    cut="$n line(s)"
  fi
  printf "EXECUTION LEG %s: failing lines (fail-lines in .github/fleet-leg) after the %s run (exit %s), their command exit %s, %s:\n" "$box" "$tag" "$rc" "$frc" "$cut" >&2
  cat "$out.shown" >&2
  # A line the byte bound cut ends here, so the closing line stands on its own.
  [ ! -s "$out.shown" ] || [ -z "$(tail -c 1 "$out.shown")" ] || printf "\n" >&2
  printf "EXECUTION LEG %s: end of the failing lines (%s run%s)\n" "$box" "$tag" "$left" >&2
  rm -f "$out" "$out.shown"
}
# go <tag> <runner...>: one run in its nested slot; <tag>-started is written by the shell the slot
# starts, just before it becomes the runner, so a slot that refused is told from a runner that ran.
go() {
  local tag="$1"; shift
  "$fw" execution slot "${nest[@]}" -- bash -c '
    case "$3" in */*) [ -f "$3" ] && [ -x "$3" ] ;; *) command -v "$3" >/dev/null ;; esac ||
      { printf "%s-unexecutable\n" "$1" >> "$2"; echo "EXECUTION LEG: $3 is not an executable command here" >&2; exit 127; }
    printf "%s-started\n" "$1" >> "$2"; shift 2; exec "$@"' leg-run "$tag" "$results" "$@" </dev/null
}
printf "started\n" >> "$results"
go main "$@"; rc=$?
printf "main=%s\n" "$rc" >> "$results"
said main "$rc" "$@"
failing main "$rc" "$@"
{ [ "$rc" -eq 0 ] && [ -n "$patch" ] && grep -qx main-started "$results"; } || exit "$rc"
# The control is made against the commit the leg reports, clean, or not at all.
now=$(git rev-parse --verify -q "HEAD^{commit}")
[ "$now" = "$head" ] || { printf "moved=%s\n" "${now:-unreadable}" >> "$results"; exit 0; }
st=$(git status --porcelain --untracked-files=all --ignore-submodules=none) || { printf "dirty=unreadable\n" >> "$results"; exit 0; }
[ -z "$st" ] || { printf "dirty=%s\n" "$(printf "%s\n" "$st" | grep -c "")" >> "$results"; exit 0; }
git apply "$patch" >&2 || { printf "apply=failed\n" >> "$results"; exit 1; }
printf "applied\n" >> "$results"
printf "EXECUTION LEG %s: control patch applied; the runner again, which must fail\n" "$box" >&2
go control "$@"; crc=$?
printf "control=%s\n" "$crc" >> "$results"
said control "$crc" "$@"
failing control "$crc" "$@"
git apply -R "$patch" >&2 && printf "revert=ok\n" >> "$results"
exit 0
FLEET_LEG_RUNS
# THE STOP (see the header): a TERM to this shell while the wrapper runs is deferred by the trap,
# never cutting a run; the stop ends the wrapper instead. INT and HUP too: a Ctrl-C or a hangup
# that reaches this shell directly (a far side started without the leg's stop armed, sharing its
# caller's group) must still let it wind down. A trap with a command is not inherited, so
# the wrapper and the runner get these signals at their defaults. Once the wrapper has returned this shell ignores
# SIGPIPE (never before: an ignored signal would be the runner's too), so a connection that is gone
# does not end it before the control is reverted and its files are removed.
stop_asked=""
trap 'stop_asked=1' TERM INT HUP
fleet_worker "${wrap[@]}" -- bash "$results.sh" "$wt" "$patch" "$results" "$BOX" "$fw" "$head" "$pin_report" "$pin_fail" "${#nest[@]}" "${nest[@]}" "$@" </dev/null; wrc=$?
trap '' PIPE
[ -z "$stop_asked" ] || say "stopped (a signal from the leg's stop, or its group's): the wrapper exit $wrc"
fact() { sed -n "s/^$1=//p" "$results" | head -n1; }
main=$(fact main)
now=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)
[ "$now" = "$head" ] || say "WARNING: HEAD of $wt is ${now:-unreadable} after the run, not $head (the runner moved it)"
# A worktree the run left dirty (ludics-lite#749), unless the control's checks below judge it.
if ! grep -qx applied "$results" && [ -z "$(fact dirty)" ]; then
  if left=$(dirt "$wt"); then
    [ -z "$left" ] || say "WARNING: $wt has $(printf '%s\n' "$left" | grep -c '') uncommitted path(s) after the run ($(printf '%s\n' "$left" | head -n 3 | tr '\n' ';')): the runner left them, and the next leg refuses this worktree until it is cleaned"
  else
    say "WARNING: cannot read the status of $wt after the run"
  fi
fi
if [ -z "$main" ]; then
  if grep -qx started "$results"; then
    say "the runner was ended before it returned (wrapper exit $wrc)"
    finish "$wrc"
  fi
  printf 'EXECUTION LEG REFUSED %s: the runner never started: %s exit %s (above)\n' "$BOX" "${wrap[*]}" "$wrc" >&2
  cleanup; exit "$wrc"
fi
if grep -qx main-unexecutable "$results"; then
  printf 'EXECUTION LEG REFUSED %s: the runner is not an executable command in %s (above); nothing ran\n' "$BOX" "$wt" >&2
  cleanup; exit 1
fi
if ! grep -qx main-started "$results"; then
  printf 'EXECUTION LEG REFUSED %s: the runner never started: its nested execution slot exit %s (above)\n' "$BOX" "$main" >&2
  cleanup; exit "$main"
fi
say "runner exit $main at $head"
{ [ "$main" -eq 0 ] && [ -n "$patch" ]; } || finish "$main"
moved=$(fact moved)
if [ -n "$moved" ]; then
  say "NO CONTROL: the main run left $wt at $moved, not $head, so a control there would not be about $head; no control verdict"
  finish 1
fi
left=$(fact dirty)
if [ -n "$left" ]; then
  say "NO CONTROL: the main run left $left changed or untracked path(s) in $wt, so a control failing there need not be the patch's doing; no control verdict"
  finish 1
fi
if [ "$(fact apply)" = failed ]; then
  printf 'EXECUTION LEG REFUSED %s: the control patch passed --check but did not apply after the run (above); %s may be dirty\n' "$BOX" "$wt" >&2
  cleanup; exit 1
fi
crc=$(fact control)
# A deadline or a signal that ended the control run ended the script that would have reverted the
# patch with it: the revert is made here, once the wrapper has reaped the group, while the patch is
# still on the box.
if [ "$(fact revert)" != ok ] && grep -qx applied "$results"; then
  if git -C "$wt" apply -R "$patch" >&2; then
    say "control patch reverted after the control run"
  else
    # The worktree is not the commit the leg reports, so no control verdict stands on it.
    say "CONTROL NOT REVERTED: the control patch could not be reverted in $wt (above), which a later leg will refuse until it is cleaned; no control verdict"
    finish 1
  fi
fi
# Reverted is not clean: the control run may have left files of its own, or moved HEAD.
if grep -qx applied "$results"; then
  left=$(dirt "$wt") || left="(git status failed)"; now=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)
  if [ -n "$left" ] || [ "$now" != "$head" ]; then
    say "NO CONTROL: after the control run $wt is not clean at $head ($(printf '%s\n' "$left" | head -n 3 | tr '\n' ';') HEAD ${now:-unreadable}), which a later leg will refuse until it is cleaned; no control verdict"
    finish 1
  fi
fi
if [ -z "$crc" ]; then
  say "the control run was ended before it returned (wrapper exit $wrc): no control verdict"
  finish "$wrc"
elif grep -qx control-unexecutable "$results"; then
  say "NO CONTROL: the control run could not execute the runner (the patch removed it, or its mode); no control verdict"
  finish 1
elif ! grep -qx control-started "$results"; then
  say "NO CONTROL: the control's nested execution slot never started the runner (exit $crc, above); no control verdict"
  finish 1
elif [ "$crc" -eq 0 ]; then
  say "CONTROL PASSED: the runner passed with $pname applied, so it does not detect what the patch breaks"
  finish 1
elif [ "$crc" -eq 124 ] || [ "$crc" -ge 128 ]; then
  say "the control run was cut (exit $crc): no control verdict"
  finish "$crc"
fi
say "control failed as required (exit $crc), patch reverted"
finish 0
"""

# THE STOP's far side (see the header), after the prelude. Args: the far shell's pid, the leg's token,
# the bound in seconds (THE GRACES' FAR_SHELL). It ignores SIGPIPE so that a connection cut under it does not end it before
# its signals are sent.
STOP = r"""pid="$1" token="$2" bound="$3"
trap '' PIPE
say() { printf 'EXECUTION LEG STOP %s: %s\n' "$BOX" "$*" >&2; }
# Still this leg: the pid's command line carries the token (bash -s -- ... <token> ...), which a
# process the system gave the pid since does not.
ours() { case " $(ps -ww -o args= -p "$pid" 2>/dev/null) " in *" $token "*) return 0 ;; esac; return 1; }
ours || { say "no leg with token $token runs as pid $pid: it has ended; nothing was signalled"; exit 0; }
# THE ESCAPED (ludics-lite#816): every process under the wrapper, as `<pid> <pgid> <start time>`, the
# start time as `ps -o lstart=` gives it in one locale and zone, blanks as `_`; zombies left out.
procs() { TZ=UTC LC_ALL=C ps -A -ww -o pid=,ppid=,pgid=,stat=,lstart= 2>/dev/null; }
tree() {
  procs | awk -v root="$1" '
    { n++; id[n] = $1; up[n] = $2; grp[n] = $3; st[n] = $4; t = $5; for (i = 6; i <= NF; i++) t = t "_" $i; at[n] = t }
    END {
      want[root] = 1
      do { more = 0; for (i = 1; i <= n; i++) if (!(id[i] in want) && (up[i] in want)) { want[id[i]] = 1; more = 1 } } while (more)
      for (i = 1; i <= n; i++) if ((id[i] in want) && st[i] !~ /^[ZX]/) print id[i], grp[i], at[i]
    }'
}
seen=""
# In its setup this ends the far shell; while the wrapper runs, its trap defers it.
kill -TERM "$pid" 2>/dev/null
sent=" "; t=0
while ours; do
  for kid in $(ps -A -ww -o pid=,ppid=,args= 2>/dev/null | awk -v p="$pid" '$2 == p && / execution (slot|hold)( |$)/ { print $1 }'); do
    # The wrapper's tree, every second while it runs: what a member that leaves the group leaves.
    seen="$seen$(tree "$kid")
"
    case "$sent" in *" $kid "*) continue ;; esac
    sent="$sent$kid "
    kill -TERM "$kid" 2>/dev/null && say "SIGTERM to the leg's wrapper (pid $kid), which ends the runner's process group"
  done
  [ "$t" -lt "$bound" ] || { say "the leg (pid $pid) still runs after ${bound}s, holding its worktree's lock; look on $BOX"; exit 1; }
  sleep 1; t=$((t + 1))
done
# THE ESCAPED: what the wrapper's group kill did not reach -- a process of its tree that had left
# the group (a group or a session of its own) -- still running once the far shell has ended: each
# `<pid> <pgid>` of the trees seen whose pid is live with the start time it was seen with.
left() {
  { printf '%s\n' "$seen"; echo --; procs; } | awk '
    $0 == "--" { now = 1; next }
    !now { if ($1 != "") was[$1 " " $3] = $2; next }
    $4 !~ /^[ZX]/ {
      t = $5; for (i = 6; i <= NF; i++) t = t "_" $i
      k = $1 " " t; if ((k in was) && !(k in done)) { done[k] = 1; print $1, was[k] }
    }'
}
pids() { left | awk '{ printf "%s%s", (NR > 1 ? " " : ""), $1 }'; }
# signal_left <signal>: to each such process, and to the group it leads (a member it started since).
signal_left() {
  local p g
  left | while read -r p g; do
    kill "-$1" "$p" 2>/dev/null
    [ "$g" != "$p" ] || kill "-$1" -- "-$g" 2>/dev/null
  done
}
esc=$(pids)
if [ -n "$esc" ]; then
  say "the leg (pid $pid) has ended, but its run left process(es) $esc running, which the wrapper's group kill did not reach: SIGTERM"
  signal_left TERM
  t=0
  while [ -n "$(left)" ] && [ "$t" -lt 50 ]; do sleep 0.2; t=$((t + 1)); done
  how=TERM
  if [ -n "$(left)" ]; then
    signal_left KILL
    how="TERM, then KILL after 10 s"
    t=0
    while [ -n "$(left)" ] && [ "$t" -lt 10 ]; do sleep 0.2; t=$((t + 1)); done
    still=$(pids)
    [ -z "$still" ] || { say "process(es) $still of the leg's run still run after SIGKILL; look on $BOX"; exit 1; }
  fi
  say "the leg's run has ended: process(es) $esc too ($how)"
  exit 0
fi
say "the leg (pid $pid) has ended"
"""
# THE GRACES (graces.py, ludics#827): the far stop waits FAR_SHELL's grace for the far shell, which
# outlasts its wrapper's (WRAPPER's, whose nested per-run slot has NESTED's), and the leg waits LEG's
# for the far stop's report, under bg-run.sh stop's BG_RUN, each from FLEET_RUNNER_GRACE.
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
ANNOUNCED = 1.0  # seconds a stop reads the far side's output for a pid line it has not yet consumed


class LegStopped(Exception):
    """A signal ended the leg while it streamed (THE STOP); the far side was dealt with."""

    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


def min_free_gib(cfg: Config) -> str:
    """THE FREE-SPACE FLOOR's knob, as the far side takes it; anything but a whole number is a usage
    error, in `leg` and in `tip-run` alike. Empty means select the project/default on the box."""
    value = knob(cfg, "FLEET_LEG_MIN_FREE_GIB", "")
    if value and not WHOLE.fullmatch(value):
        die(f"FLEET_LEG_MIN_FREE_GIB must be a whole number of GiB (0 for no floor), not {value!r}")
    return value


def refused(text: str, rc: int = 1) -> int:
    cli.say(f"EXECUTION LEG REFUSED: {text}")
    return rc


LEG_VOICE = slot.Voice("EXECUTION LEG", "running the leg", "nothing ran")


def window_bound(slot_flags: list[str]) -> slot.WindowBound | None:
    """The leg's ``--wait-window`` bound, the last given winning as in the slot: its seconds, or for a
    bare one ``slot.BY_DEADLINE`` (the window's own deadline, ludics-lite#737); None without one."""
    bound: slot.WindowBound | None = None
    for flag in slot_flags:
        if flag == "--wait-window":
            bound = slot.BY_DEADLINE
        elif flag.startswith("--wait-window="):
            bound = int(flag[len("--wait-window=") :])
    return bound


def await_window(cfg: Config, request: str, record: dict[str, Any], records: list[dict[str, Any]],
                 slot_flags: list[str], runner: list[str]) -> dict[str, Any] | int:
    """THE WINDOW WAIT (see the header) for a ``suspended`` record: the record read again once no
    measurement holds its box; or the refusal's status."""
    window = execution.jq_text(record.get("suspended_by"))
    bound = window_bound(slot_flags)
    if bound is None:
        return refused(f"{request} is suspended by measurement window {window}; run the leg once that window"
                       " concludes, or give it --wait-window, which waits for it")
    host = execution.jq_text(execution.field(record, "request", "execution_host"))

    def holders(read: list[dict[str, Any]]) -> list[dict[str, Any]] | slot.Ended:
        # The box's measurements; else the window this record is still suspended by, from the read
        # or by its id alone when the read does not list it (a torn read, see the header).
        own = execution.record_of(read, request)
        if own is None or own.get("state") not in ("suspended", *DISPATCHED):
            # Gone or concluded: nothing to wait for, and the leg refuses it -- without the wait's
            # line that the box is free and the leg runs (ludics#710).
            return slot.Ended(read)
        held = slot.measurement_records(read, host)
        if held or own.get("state") != "suspended":
            return held
        by = execution.jq_text(own.get("suspended_by"))
        return [execution.record_of(read, by) or {"request_id": by, "window": True}]

    waited = slot.await_measurements(cfg, host, records, bound, runner, LEG_VOICE, holders, registered=True)
    if isinstance(waited, int):
        return waited
    again = execution.record_of(waited, request)
    if again is None:
        return refused(f"unknown request_id {request} after waiting for window {window}: a leg runs only inside"
                       " a dispatched reservation")
    return again


def box_path(value: str, flag: str) -> str:
    """A path on the box: absolute, or ``~/`` (expanded there)."""
    if not (value.startswith("/") or value.startswith("~/")):
        die(f"execution leg: {flag} must be absolute on the box (or ~/...), not {value!r}")
    return value


def cmd_leg(cfg: Config, args: list[str], *, hold: bool = False) -> int:
    try:
        return leg_command(cfg, args, hold=hold)
    except LegStopped as stopped:
        # THE STOP: die of the signal, as the slot's wrapper does, so a caller reads what it sent.
        signal.signal(stopped.signum, signal.SIG_DFL)
        os.kill(os.getpid(), stopped.signum)
        return 128 + stopped.signum


def leg_command(cfg: Config, args: list[str], *, hold: bool = False) -> int:
    values: dict[str, str] = {}
    slot_flags: list[str] = []
    runner: list[str] = []
    no_config = False
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            runner = args[i + 1 :]
            break
        if arg == "--reads-no-config":
            no_config = True
            i += 1
            continue
        if arg in ("--request", "--box", "--rev", "--checkout", "--worktree", "--remote", "--base", "--control", "--file"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"execution leg: expected a value for {arg}")
            values[arg] = args[i + 1]
            i += 2
            continue
        if arg in slot_flags and arg in ("--wait", "--deadline"):
            die(f"execution leg: {arg} given twice")
        if arg in ("--wait", "--deadline"):
            # --wait 0 is the slot's refuse-at-once; a deadline is positive.
            if i + 1 >= len(args) or not (SECONDS if arg == "--deadline" else WHOLE).fullmatch(args[i + 1]):
                die(f"execution leg: {arg} takes a {'positive ' if arg == '--deadline' else ''}whole number of seconds")
            slot_flags += [arg, args[i + 1]]
            i += 2
            continue
        if arg in ("--cpu", "--gpu", "--wait-window") or (
            arg.startswith("--wait-window=") and WHOLE.fullmatch(arg[len("--wait-window=") :])
        ):
            slot_flags.append(arg)
            i += 1
            continue
        die(USAGE)
    if not runner:
        die(USAGE)
    try:
        graces.runner(cfg.env)  # THE GRACES' input, refused before anything reaches the box
    except ValueError as exc:
        die(f"execution {'hold' if hold else 'leg'}: {exc}")
    for flag in ("--request", "--rev", "--checkout", "--worktree"):
        if flag not in values:
            die(f"execution leg: {flag} required ({USAGE})")
    request, rev = values["--request"], values["--rev"]
    checkout = box_path(values["--checkout"], "--checkout")
    worktree = box_path(values["--worktree"], "--worktree")
    if checkout.rstrip("/") == worktree.rstrip("/"):
        die("execution leg: --worktree must not be --checkout; a leg moves only a linked worktree")
    remote = values.get("--remote", "origin")
    if not REMOTE.fullmatch(remote) or remote.startswith("-"):
        die(f"execution leg: --remote must be a remote's name, not {remote!r}")
    if not ref_name_ok(rev) or (not OBJECT_ID.fullmatch(rev) and not revision.git_branch_ok(rev)):
        die(f"execution leg: --rev must be a full commit SHA or a branch name, not {rev!r}")
    if HEX.fullmatch(rev) and not OBJECT_ID.fullmatch(rev):
        die(f"execution leg: --rev {rev} looks like an abbreviated or uppercase SHA: give the full one (git rev-parse)")
    # THE BASE (see the header): a branch of --remote, by git's rules and the registry's alphabet.
    base = values.get("--base", "")
    if base and (not ref_name_ok(base) or not revision.git_branch_ok(base) or base.startswith("-")):
        die(f"execution leg: --base must be a branch name of {remote}, not {base!r}")
    control = values.get("--control", "")
    if control and not (os.path.isfile(control) and os.access(control, os.R_OK)):
        die(f"execution leg: --control {control} is not a readable patch file")
    # THE FILE (see the header): a --file and a runner word {file} come together, or not at all.
    shipped = values.get("--file", "")
    if shipped and not (os.path.isfile(shipped) and os.access(shipped, os.R_OK)):
        die(f"execution leg: --file {shipped} is not a readable file on this box")
    if shipped and FILE_WORD not in runner:
        die(f"execution leg: --file {shipped} is shipped to the box for the runner word {FILE_WORD}, which the runner"
            f" does not have: name it where the runner reads the file (e.g. --targets-file {FILE_WORD})")
    if not shipped and FILE_WORD in runner:
        die(f"execution leg: the runner word {FILE_WORD} names the leg's --file <local file>, which was not given")

    fetch_timeout = knob(cfg, "FLEET_FETCH_TIMEOUT", "300")
    if not SECONDS.fullmatch(fetch_timeout):
        die(f"FLEET_FETCH_TIMEOUT must be a positive whole number of seconds, not {fetch_timeout!r}")
    min_free_gib(cfg)  # a usage error before the reservation is read; run_leg passes it on

    # The reservation: a dispatched record, whose execution host is the box. A leg that may wait out a
    # window registers as its waiter in this same read, by its request (THE WAITERS, ludics-lite#719):
    # the read that finds its record suspended must not leave a moment unseen before the first heartbeat.
    # It releases the heartbeat when it does not wait, or its wait is refused; after a wait it lets it
    # expire, so the moment of setup before its slot on the box (the copy, the ssh, the fetch) is
    # still counted, and the slot there, given --wait-window too, registers on its own.
    waiter = slot.waiter_of(cfg, runner, request=request) if window_bound(slot_flags) is not None else None
    done = execution.listing(cfg, waiter)
    if done.unreachable:
        cli.say(f"EXECUTION LEG UNREACHABLE {cfg.anchor}: cannot read request {request}'s record; nothing ran")
        return 4
    records = execution.records_of(done.out) if done.rc == 0 else None
    if records is None:
        cli.emit(substitution(done.out))
        return refused("the anchor's registry could not be read; nothing ran")
    record = execution.record_of(records, request)
    if record is None:
        return refused(f"unknown request_id {request}: a leg runs only inside a dispatched reservation")
    host = execution.jq_text(execution.field(record, "request", "execution_host"))
    box = values.get("--box", host)
    # The box before any wait: a leg named for another box is refused now, not after a window.
    if fleet_name(cfg, box) != host:
        slot.release_waiter(cfg, waiter)
        return refused(f"{request} is reserved on {host}, not {box}")
    if execution.jq_text(record.get("state")) == "suspended":
        waited = await_window(cfg, request, record, records, slot_flags, runner)
        if isinstance(waited, int):
            slot.release_waiter(cfg, waiter)
            return waited
        record = waited
        try:
            # Kept through the setup before the slot on the box, and released when the leg ends,
            # whatever ends it: a heartbeat left to expire would make a window opened just after a
            # short leg wait out the gap for nobody.
            return run_leg(cfg, request, record, slot_flags, runner, box, checkout, worktree, remote, rev, control,
                           fetch_timeout, hold=hold, shipped=shipped, no_config=no_config, base=base)
        finally:
            slot.release_waiter(cfg, waiter)
    slot.release_waiter(cfg, waiter)
    return run_leg(cfg, request, record, slot_flags, runner, box, checkout, worktree, remote, rev, control,
                   fetch_timeout, hold=hold, shipped=shipped, no_config=no_config, base=base)


def run_leg(cfg: Config, request: str, record: dict[str, Any], slot_flags: list[str], runner: list[str], box: str, checkout: str, worktree: str, remote: str, rev: str, control: str,
            fetch_timeout: str, *, hold: bool = False, shipped: str = "", no_config: bool = False, base: str = "") -> int:
    """The leg on its dispatched record: refuse what the registry would not record, then run it on
    ``box`` (the far side's slot or hold around it) and stream its result."""
    state = execution.jq_text(record.get("state"))
    if state not in DISPATCHED:
        return refused(f"{request} is {state}, not dispatched (launching, running or uncertain); nothing ran")
    # THE RECORD'S CHECKOUT (see the header).
    bound = execution.recorded_checkout(record)
    if bound and bound.rstrip("/") != worktree.rstrip("/"):
        host = execution.jq_text(execution.field(record, "request", "execution_host"))
        return refused(f"--worktree {execution.shown(worktree)} is not {request}'s recorded checkout"
                       f" {execution.shown(bound)} on {host}"
                       " (ludics-lite#749: a leg moves only its own record's worktree); nothing ran")
    kind = execution.jq_text(execution.field(record, "request", "kind"))
    if hold and kind != "measurement":
        return refused(f"{request} is a {kind or 'kindless'} request, not a measurement: `execution hold --worktree` runs a"
                       " measurement's command; a correctness run in a worktree is an `execution leg`; nothing ran")
    if kind == "measurement":
        extra = [flag for flag in slot_flags if flag.startswith("--") and flag != "--deadline"]
        if extra:
            die(f"execution leg: {request} is a measurement, run under `execution hold`, which takes no slot: drop {' '.join(extra)}")
    # The bound is each run's (the leg's --deadline, or a day), carried by the nested slot of each
    # run, which reaps that run's group as it ends; the enclosing wrapper, holding both runs, takes
    # none, so a main run cannot spend the control's time.
    deadline = slot_flags[slot_flags.index("--deadline") + 1] if "--deadline" in slot_flags else RUN_BOUND
    if "--deadline" in slot_flags:
        at = slot_flags.index("--deadline")
        slot_flags = slot_flags[:at] + slot_flags[at + 2 :]
    if kind == "measurement":
        wrap = ["execution", "hold", "--request", request, *slot_flags]
    else:
        wrap = ["execution", "slot", *slot_flags]
    nest = ["--deadline", deadline, *[flag for flag in slot_flags if flag in ("--cpu", "--gpu")]]
    # The registry's binding (ludics-lite#634): the commit it would accept as this record's
    # observed_sha, so the leg runs nothing the registry would refuse to record.
    want = bound_commit(record) or ""
    requested = execution.field(record, "request", "requested_revision")
    standing = execution.field(record, "request", "standing") is True
    if isinstance(requested, str) and requested.startswith("head-of:") and not want and not standing:
        # Reconciled to running without a dispatch, say: the branch was never resolved, so no commit
        # is this request's, and any --rev would pass.
        return refused(f"{request} follows {requested} but records no resolved_revision (it was never dispatched);"
                       " reconcile it to reserved and dispatch it, which resolves the branch")

    # One random token per invocation: the status line's (see the header), and the staged patch's
    # name on the box, which no other leg's can share.
    token = secrets.token_hex(8)
    stem = f"{re.sub(r'[^A-Za-z0-9._-]', '_', request)}.{token}"
    pname = ""
    if control:
        pname = f"{stem}.patch"
        sent = put_file(cfg, box, control, f"{cfg.state}/leg-control/{pname}")
        if sent.rc != 0:
            if sent.unreachable:
                cli.say(f"EXECUTION LEG UNREACHABLE {box}: the control patch could not be copied; nothing ran")
                return 4
            return refused(f"the control patch could not be copied to {box} (exit {sent.rc}); nothing ran")
    fname = ""
    if shipped:
        # The copy keeps the file's own name after the stem, so the runner's messages still say it.
        fname = f"{stem}.{re.sub(r'[^A-Za-z0-9._-]', '_', os.path.basename(shipped))}"
        sent = put_file(cfg, box, shipped, f"{cfg.state}/leg-files/{fname}")
        if sent.rc != 0:
            if sent.unreachable:
                cli.say(f"EXECUTION LEG UNREACHABLE {box}: the --file could not be copied; nothing ran")
                return 4
            return refused(f"the --file could not be copied to {box} (exit {sent.rc}); nothing ran")

    script = prelude(cfg, box) + LEG
    argv = far_argv(
        cfg, box,
        [checkout, worktree, remote, rev, want, pname, request, fetch_timeout, token, fname, "1" if no_config else "0",
         min_free_gib(cfg), base,
         str(len(wrap)), *wrap,
         str(len(nest)), *nest, *runner],
    )

    def stop(far_pid: str) -> tuple[list[str], str]:
        return far_argv(cfg, box, [far_pid, token, str(graces.seconds(graces.FAR_SHELL, cfg.env))]), prelude(cfg, box) + STOP

    return stream(argv, script, box, token, local=is_local(cfg, box), stop=stop,
                  stop_wait=graces.seconds(graces.LEG, cfg.env))


def hold_in_worktree(cfg: Config, request: str, rev: str, checkout: str, worktree: str, deadline: int | None,
                     command: list[str], *, no_config: bool = False) -> int:
    """``execution hold --request <id> --worktree <dir> --rev <rev> [--checkout <dir>] [--reads-no-config]``
    (ludics-lite#816):
    the measurement's command in a worktree of THIS box, made or moved to the commit, as a leg on this
    box -- THE CHECKOUT AND THE REVISION, THE RECORD'S CHECKOUT, THE BACKEND PIN and THE STOP as above,
    under the ``execution hold --request`` a measurement's leg runs in, its status line the leg's. The
    record must be a measurement dispatched on this box. ``--checkout`` defaults to the checkout the
    hold is run from (the top of the current directory's worktree), which is where a hold without
    ``--worktree`` runs its command."""
    if not cfg.local_box:
        die("execution hold: --request needs this host's fleet name; set FLEET_LOCAL_BOX")
    if not checkout:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False)
        checkout = top.stdout.strip()
        if top.returncode != 0 or not checkout:
            die("execution hold: --worktree needs a checkout of the project to make the worktree from: run it from"
                " one, or name it with --checkout")
    args = ["--request", request, "--box", cfg.local_box, "--rev", rev, "--checkout", checkout, "--worktree", worktree]
    if deadline is not None:
        args += ["--deadline", str(deadline)]
    if no_config:
        args.append("--reads-no-config")
    return cmd_leg(cfg, [*args, "--", *command], hold=True)


def end_far(box: str, far_pid: str | None, signum: int, stop: Callable[[str], tuple[list[str], str]], *,
            local: bool, wait: float) -> None:
    """THE STOP (see the header): end the far side whose shell reported ``far_pid``, through a far
    stop in a session of its own, waiting up to ``wait`` seconds (THE GRACES' LEG) for its report."""
    name = signal.Signals(signum).name
    if far_pid is None:
        cli.say(f"EXECUTION LEG STOPPED {box}: {name} before the far side reported its pid; whether the runner"
                f" started there is unknown -- look on {box} before running the leg again")
        return
    cli.say(f"EXECUTION LEG STOPPING {box}: {name}; ending the far side (pid {far_pid})")
    argv, script = stop(far_pid)
    sys.stdout.flush()
    sys.stderr.flush()
    remedy = f"ssh {box} pkill -TERM -P {far_pid} -f 'execution (slot|hold)'"
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, start_new_session=True)
    except OSError as exc:
        cli.say(f"EXECUTION LEG STOP UNREACHABLE {box}: {argv[0]}: {exc.strerror}; the far side (pid {far_pid})"
                f" may still run and hold its worktree's lock: {remedy}")
        return
    stop_in = proc.stdin
    assert stop_in is not None

    def feed() -> None:
        # From a thread, so a stop ssh that is slow to read cannot hold this past the wait.
        try:
            stop_in.write(script.encode("utf-8", "surrogateescape"))
            stop_in.close()
        except OSError:
            pass

    threading.Thread(target=feed, daemon=True).start()
    try:
        rc = proc.wait(timeout=wait)
    except subprocess.TimeoutExpired:
        cli.say(f"EXECUTION LEG STOPPING {box}: the far stop goes on after {wait:g}s; its last line follows on"
                " this output")
        return
    if rc == 255 and not local:
        cli.say(f"EXECUTION LEG STOP UNREACHABLE {box}: ssh failed; the far side (pid {far_pid}) may still run and"
                f" hold its worktree's lock: {remedy}")
    elif rc != 0:
        cli.say(f"EXECUTION LEG STOPPING {box}: the far stop exit {rc} (above); if the far side still runs: {remedy}")


def stream(argv: list[str], script: str, box: str, token: str, *, local: bool,
           stop: Callable[[str], tuple[list[str], str]] | None = None, stop_wait: float | None = None) -> int:
    """Run the far side with its stdout passed through, watching for its status line under
    ``token``: the runner's status when it came (printed last, as the plain sentinel), else the far
    side's own (or UNREACHABLE for ssh's 255). With ``stop``, which builds the far stop's argv and
    script for a pid, a SIGTERM, SIGINT or SIGHUP while it streams ends the far side too, waiting up
    to ``stop_wait`` seconds for the far stop (THE GRACES' LEG; by default the default input's), and
    raises LegStopped (THE STOP)."""
    # The status line ends the far side's output; after a runner whose output ended with no newline
    # it ends that line, whose text is kept and ended.
    reported = re.compile(rb"execution-leg " + re.escape(token.encode()) + rb": exit: ([0-9]{1,3})\r?\n?\Z")
    far = re.compile(rb"execution-leg " + re.escape(token.encode()) + rb": far: ([0-9]+)\r?\n")
    sentinel: int | None = None
    far_pid: str | None = None
    out = sys.stdout.buffer

    def line_out(line: bytes) -> None:
        nonlocal sentinel, far_pid
        if far_pid is None and (pid := far.fullmatch(line)):
            far_pid = pid.group(1).decode()
            return
        found = reported.search(line)
        if found:
            sentinel = int(found.group(1))
            if found.start() > 0:
                out.write(line[: found.start()] + b"\n")
        else:
            out.write(line)

    # While the far side is being spawned a signal is only noted, and raised once ``child`` holds
    # it: raised inside Popen it would leave a started child no stop can reach. ``noted`` is never
    # cleared, and ``spawning`` turns off in one assignment, so a signal is either noted and raised
    # below or raised by the handler itself.
    spawning = False
    noted = 0

    def stopped(signum: int, frame: FrameType | None) -> None:
        nonlocal noted
        if spawning:
            noted = noted or signum
            return
        raise LegStopped(signum)

    sys.stdout.flush()
    sys.stderr.flush()
    # The handlers go in before the far side starts, so no moment of it runs unreachable by a stop.
    previous: dict[signal.Signals, Any] = {}
    child: "subprocess.Popen[bytes] | None" = None
    feeder: threading.Thread | None = None
    pending = b""

    def take(chunk: bytes) -> None:
        nonlocal pending
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for line in lines:
            line_out(line + b"\n")
        if len(pending) > HELD_BACK:
            out.write(pending[:-HELD_BACK])
            pending = pending[-HELD_BACK:]
        out.flush()

    def announced(fd: int, within: float) -> None:
        # The far side's pid line may already sit in the pipe, unread, when the signal lands: read
        # what comes within ``within`` seconds, until it is seen or the far side's output ends.
        until = time.monotonic() + within
        while far_pid is None and (left := until - time.monotonic()) > 0:
            if not select.select([fd], [], [], left)[0]:
                return
            chunk = os.read(fd, 65536)
            if not chunk:
                return
            take(chunk)

    try:
        if stop is not None and threading.current_thread() is threading.main_thread():
            for sig in STOP_SIGNALS:
                previous[sig] = signal.signal(sig, stopped)
        spawning = True
        try:
            # On the caller's own box the far shell gets a session of its own, as ssh's far side has
            # (THE ESCAPED): a group signal aimed at the leg must not reach the wrapper before the far
            # stop has seen its tree. Only where the stop is armed, which then reaches it.
            child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0,
                                     start_new_session=local and bool(previous))
        except OSError as exc:
            sys.stderr.write(f"{argv[0]}: {exc.strerror}\n")
            return 127
        finally:
            spawning = False
        if noted:
            raise LegStopped(noted)
        assert child.stdin is not None and child.stdout is not None
        stdin = child.stdin

        def feed() -> None:
            # From a thread of its own: bash reads a script on stdin as it runs it, so a far side
            # that writes before it has read the whole script must never wait for this write.
            try:
                stdin.write(script.encode("utf-8", "surrogateescape"))
                stdin.close()
            except OSError:
                pass

        feeder = threading.Thread(target=feed, daemon=True)
        feeder.start()
        # Bounded reads, not readline: a runner's output with no newline in it (progress bars,
        # binary) passes through as it comes, and only a short tail of an unfinished line is held
        # back, enough for a sentinel at its end to be seen.
        fd = child.stdout.fileno()
        while chunk := os.read(fd, 65536):
            take(chunk)
        if pending:
            line_out(pending)
            out.flush()
        rc = child.wait()
    except LegStopped as why:
        # A second signal ends this process at once; the far stop runs in a session of its own.
        for sig in previous:
            signal.signal(sig, signal.SIG_DFL)
        try:
            out.flush()
        except OSError:
            pass
        assert stop is not None
        if far_pid is None and child is not None and child.stdout is not None:
            # The far shell's first line is its pid: read it if it is already written (up to
            # ANNOUNCED seconds). With none, on the caller's box this is the far shell before its
            # first line, which nothing else has started (in its own session, so a group signal did
            # not reach it), and over ssh the client.
            try:
                announced(child.stdout.fileno(), ANNOUNCED)
            except OSError:
                pass
            if far_pid is None:
                child.kill()
        end_far(box, far_pid, why.signum, stop, local=local,
                wait=graces.seconds(graces.LEG, {}) if stop_wait is None else stop_wait)
        if child is not None and child.stdout is not None:
            child.stdout.close()
        raise
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    feeder.join()
    if sentinel is not None:
        out.write(b"execution-leg: exit: %d\n" % sentinel)
        out.flush()
        return sentinel
    if rc == 255 and not local:
        cli.say(
            f"EXECUTION LEG UNREACHABLE {box}: ssh failed or the connection dropped before the leg reported;"
            " the runner may have started there -- check the box before running the leg again"
        )
        return 4
    return rc
