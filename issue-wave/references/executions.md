# Coordinator-owned execution reservations

Use `fleet-worker.sh execution` for every worker correctness or measurement run on a fleet box
and every coordinator integration run, with either provider and any transport: a CLI worker
running tests on its own agent host exactly as much as a native worker driving that host over
ssh. Agent residence never grants execution ownership. Python 3.12 or newer is required on the
anchor, where the registry runs, and on every box that runs batches, where `execution slot` runs
through `scripts/py` (ludics-lite#403); the per-box preflight asks for one in `scripts/py`'s own
order (`LUDICS_PY_CANDIDATES` honoured) and refuses a box with none, or with one that cannot
import fcntl. State lives in `FLEET_ANCHOR_STATE/executions`, under the existing coordinator lease
lock. Use the same fleet environment as `claim`.

The vocabulary is SKILL.md's: a worker *requests*, the coordinator *reserves* (one record in
this registry), and the *assignment* is the message that resumes the worker with the reserved
command.

## Exclusivity and the run-time slots

A `measurement` reservation is for timing-grade claims, and for a run that needs the box to
itself (a [dual-boot reboot](#bounded-native-windows-verification) ends everything there). A
behaviour check that happens to print timings is `correctness`, and its timings are reported as
shared-box (2026-09-25: a warm-cache A/B whose claim was which arms replay asked for an exclusive
mac-studio measurement, impossible while a wave shares the box, and was reclassified). A
measurement is exclusive: it is refused while anything is outstanding on its host, and
everything is refused while it is outstanding (standing reservations are suspended for it by a
[measurement window](#exclusivity-and-the-run-time-slots), not refused). A `correctness` reservation shares its
host with other correctness reservations up to the box's slots - `FLEET_BOX_CORRECTNESS_SLOTS`,
`<box>=<n>` pairs, `mac-studio=6 rog-nv-linux=4 minix-amd-linux=4 tuf-amd-linux=3` with the
default roster and one slot for any box it does not name. The default roster is the default set of boxes, whether
`FLEET_BOXES` is unset or exports those same boxes (ludics-lite#329), and `fleet-worker.sh
preflight` prints the count for every roster box (ludics-lite#157: the exclusivity was written for
measurement noise and for XProtect serializing fresh test binaries, and three workers' targeted
`-j 4` batches ran side by side on the Mac without a stall once the Developer Tools exemption was
in place). Keep one slot for WSL boxes because of the measured dxg bridge limit. The native GPU
boxes' counts were measured with 1-4 concurrent compile-inclusive targeted batches, each box under
an exclusive reservation (ludics-lite#316, #344), at the width each batch runs at: four `-j 4`
batches on minix-amd-linux (16 hip-width at once was green three ways; only dune's default 32 has
drained its device-wide SDMA queue pool), three `-j 8` on tuf-amd-linux, and two `-j 8` cuda
batches on rog-nv-linux, where three or more hit `CUDA_ERROR_OUT_OF_MEMORY` in 2 of 6 rungs while
two ran clean beside two cc batches. OCANNL's `tools/test-run.sh` injects those widths into a
native batch that names none (ahrefs/ocannl#1033; `tools/box-jobs.sh` restates the counts, so the
two change together), so a worker passes no `-j` for them. The kind does not silently change the
configured slot count.

Where the bound is the GPU and not the box, some of the slots are GPU tokens (ludics-lite#391):
`FLEET_BOX_GPU_TOKENS`, the same `<box>=<n>` grammar, `rog-nv-linux=2` with the default roster,
and one per slot on any box it does not name. So rog-nv-linux runs four slots, and at most two
batches hold its 12 GiB GPU. It is fail-closed: every batch is a GPU batch unless it declares
`execution slot --cpu` (a CPU backend such as OCANNL's cc, or a repository with no GPU work;
`--gpu` states the default), so a GPU batch whose caller forgot to say so is still counted, and
a CPU batch that forgot only waits longer. The tokens are the first N slot files, not a second
pool: a batch the script before #391 started holds one of rog's first two slots, so it counts as
a token while a box's checkout moves between the versions. `preflight` shows the tokens beside
the slots wherever they are fewer, as `rog-nv-linux=4(gpu=2)`.

The slot count is a RUN-TIME count, and `execution slot` is the single run-time mechanism
(ludics-lite#160): every correctness run on a box, assigned or standing, is wrapped in
`fleet-worker.sh execution slot [--wait <seconds>] [--wait-window[=<seconds>]] [--cpu|--gpu] [--deadline <seconds>] -- <command>` on that box, so the box never
carries more than its slots however the runs were authorized. A reservation carrying
`"standing": true` - a correctness record held for a worker's whole life, review waits and idle
included - consumes no slot; it stays outstanding for everything else, so a measurement still
needs the box to itself. The registry's cap stays a bound on how many non-standing reservations
may be outstanding on a box and is deliberately NOT subtracted from the run-time slots: a run
refused because of a record that is not running, its own included, is the defect ludics-lite#160
removed (2026-09-16: a fourth worker was refused a reservation while the three holding
mac-studio's slots were reading their briefs; six slots, not three, for the same reason - the
cap bounds concurrent load, never how many agents may be in flight).

`execution slot` runs on the worker's own box around one suite or batch: it refuses while a
measurement is outstanding on that box (except the measurement's own run, below), holds one of the box's N slots (a GPU token one, unless
`--cpu`) as a real flock for exactly as long as the command runs (the kernel drops it even when the batch is killed), and
returns the command's own status. It needs no coordinator lease, takes no `--box` (the slot is
the local box's), and refuses with a line beginning `EXECUTION SLOT REFUSED` - exit 1 for no
free slot or token, a measurement, a malformed spec or a local box name outside `FLEET_BOXES` (an alias
would lock and read measurements under a spelling of its own), 4 when the anchor's registry
cannot be read. Its lock files live under `FLEET_SLOT_STATE`
(`~/.local/state/fleet-execution-slots/<box>`), which is box-wide on purpose: `ISSUE_WAVE_STATE`
is each coordinator's own directory, and slots kept there would let two workers under different
coordinators each take slot 1 on one machine. The command after `--` is exec'd, not
interpreted, so a pipeline or a shell builtin goes as `sh -c '...'`. A batch that can outlast
the 600 s tool cap takes `--bg <parent>` (ludics-lite#181): the same slot-held batch, detached
under `bg-run.sh spawn`, whose one foreground call prints the run directory at once; a Claude
worker blocks on it with `bg-run.sh wait` ([Blocking on a
run](native-claude.md#blocking-on-a-run)), and `execution conclude --from-bg-run` reads it.

**Nested slots.** A held slot exports `FLEET_SLOT_HELD` (`<box> <slot> <slots> <gpu|cpu>`) to
its command, and an `execution slot` that finds it runs its command under the enclosing slot
instead of taking a second one (ahrefs/ocannl#1004). That lets a project runner take the slot
itself: OCANNL's `tools/test-run.sh` does, declaring `--cpu` when the backend it resolves is a
CPU one. It first asks `execution slot --probe`, which prints `EXECUTION SLOT PROBE <box> <slots>
<gpu tokens>` and takes no lock and reads no registry. It needs no Python 3.12, so a box
without one still answers, and the slot that follows refuses loudly. Any answer other than that line (a host
with no fleet name, or a fleet-worker.sh too old to have the probe) makes the runner run
without a slot, as it did before. A worker's wrapper around such a runner is harmless, because the runner runs inside
it. Without this, two slots per batch would fill a box at half its count, and a full box would
deadlock until the deadline. The marker is checked, not trusted: it has to name this box and a
slot that is held now, or it is reported and ignored. The GPU check reads the current token
spec rather than the marker, so a GPU batch inside a slot that an enclosing batch took as
`--cpu` is refused. A wrapper around a runner that may hold the GPU must therefore not declare
`--cpu`, and the runner's own declaration is the better one to rely on.

**The measurement's own run** (ludics-lite#480). A runner that takes the slot itself also does so
inside a measurement, where every slot is refused - so OCANNL's `tools/test-run.sh` was refused by
its own measurement (exit 75, `SLOT REFUSED`) five times in the 2026-09-30 wave, until briefs
carried `OCANNL_TOOL_FLEET_WORKER=none`. So a measurement runs under `fleet-worker.sh execution
hold --request <request_id> -- <runner command>`, which exports `FLEET_MEASUREMENT_HELD` (`<box>
<request_id>`) and holds a shared lock for as long as the runner's process tree runs; an
`execution slot` inside it runs its command under the hold, taking no slot and no second sleep
guard, and logs `inside measurement <id>`. `execution slot --probe` there appends `measurement
<id>` to its line. The marker is checked, not trusted: the registry's outstanding measurements
on this box must be exactly that request, and some `hold --request` on the box must hold its lock
now. A marker naming another box, an unknown or concluded request, or no live hold is reported
and ignored, so the batch is refused as any other is while a measurement is outstanding - and so
is every batch with no marker, an independent correctness batch on the measured box included.

**The measurement window** (ludics-lite#481). Every native worker holds a standing reservation on
its agent host for its whole life, so a measurement there was never admitted: the 2026-09-30 wave's
first Metal measurement on mac-studio waited about five hours, and the coordinator then opened each
"Metal window" by hand - concluding every standing reservation `cancelled` (a conclusion describing
no run), messaging the workers, measuring, and taking fresh reservations under invented ids. Now a
measurement on a box where standing reservations are outstanding is reserved with
`fleet-worker.sh execution window <box> <reserve.json>` in place of `execution run`. Under one
registry lock it refuses unless everything outstanding on the box is standing (an assigned
correctness run or another measurement still refuses it, naming the owners; an open window by
name), reserves and dispatches the measurement as `run` does (its record carries `"window": true`),
and moves each standing reservation there to state `suspended`, naming the measurement in
`suspended_by` and the state it left in `suspended_from`. It prints the measurement's record, and
on stderr `EXECUTION WINDOW <box>: <id> open; suspended <ids>`. Concluding the measurement, whatever
the verdict, restores every reservation it suspended to its former state, with the same request ids
(`EXECUTION WINDOW <box>: <id> concluded; restored <id> (<state>), ...` on stderr). While the window is open:

- `execution slot` on the box refuses a batch with `EXECUTION SLOT REFUSED <box>: measurement window
  <id> is open on <box> ...`, so a caller knows to retry after it closes rather than to debug or to
  request; the measurement's own run is admitted inside its `hold --request`, as
  [above](#exclusivity-and-the-run-time-slots). `execution slot --wait-window[=<seconds>]`
  (ludics-lite#557; an hour when no bound is given) waits for the measurement instead, a window
  or not: it names the measurement, its box and its coordinator once (`EXECUTION SLOT <box>:
  measurement window <id> holds <box> (coordinator ...)`), says it is still waiting every 60
  seconds, re-reads the registry every `FLEET_SLOT_WINDOW_POLL` seconds (15), and refuses at
  its bound with `... still holds <box> after <n>s (--wait-window)`; once nothing is outstanding
  it waits for a slot as `--wait` says, each wait with its own bound. A measurement on another
  box never makes it wait, and it does not wait inside a measurement's hold (it would wait for
  its own measurement). It is a flag of its own rather than a wider `--wait`, so a runner's
  nested slot that relies on the immediate refusal is never parked for a whole window.
- a standing reservation taken on the box is queued into the window - admitted straight into
  `suspended` and restored with the others - so a worker's launch never waits for a window;
- a suspended reservation takes no dispatch, record or reconcile (the window owns its state), but
  may be concluded: a worker handing back mid-window ends its reservation as usual;
- a second `execution window` on the box is refused naming the open one. One measurement per window
  keeps the registry at one outstanding measurement per box, which the in-hold admission above
  relies on, and gives each request its own record, assignment and conclusion.

`execution list --active --compact` shows a suspended reservation by its state and its
`suspended_by`, and `--host <box>` narrows any listing to one box's records - an alias, such as
`rog` for `rog-nv-linux`, selecting its roster entry's by the endpoint map, and a name that is no
roster box refused - which is the read for "is a window open on this box". A retried `window` with the same payload never dispatches twice: it suspends any
standing reservation still outstanding there and prints the record. A standing reservation queued
into a window is not followed by the usual [refresh](#reserve-launch-observe-conclude) of the box,
which is measuring: `REFRESH DEFERRED <box>` names the refresh to run once the window concludes.

The refusal above is a registry read at the batch's start, so it cannot stop a batch that was
already running, or already waiting for a slot, when the window opened. **The drain** closes that:
`execution hold --request <id>` takes every slot of the box (`slot.1` up to the box's count, and
any other slot file there) before its runner starts, waiting for a running batch to end with
`EXECUTION HOLD <box>: measurement <id> waits for the batch in slot <n> to end`, and holds them
for as long as the runner's tree runs. So no batch runs beside the measurement however it was
admitted: a batch waiting for a slot either ends before the measurement starts or starts after it
ends. While such a hold is live a `FLEET_SLOT_HELD` marker is not trusted, since the slot it names
is held by the hold, not by an enclosing batch; the measurement's own runs carry its marker
instead. A hold nested in a live hold of the same measurement takes no slots (they are its
enclosing hold's), and a second, concurrent hold of it waits for the first to end. A batch under a
hold whose measurement is no longer outstanding runs under that hold, which holds the box's
slots, rather than waiting for one of them. The drain applies to every measurement, though only a
window's ever had batches to wait for. A slot file the hold cannot lock is a loud `WARNING`, never
a refused measurement, as with the marker.

**The GPU co-tenants** (ludics-lite#566). The drain keeps the fleet's batches off the box, but not
what the fleet does not run: in the 2026-10-05 wave a minix A/B was refused for its timing
windows, and the likeliest cause, a VS Code server sharing the integrated GPU, appeared nowhere in
the window's record. So `execution hold --request <id>` records the box's GPU-using processes
outside its own tree (the hold, its descendants and its command's process group) twice: just before
the runner starts, after the drain (written once it has started, so a runner that cannot be started
records nothing; `--deadline` counts from the runner's start, as ever), and once the runner has
ended, however it ended. It says each on
stderr (`EXECUTION HOLD <box>: measurement <id>: GPU co-tenants at open: ...`, then `at close:
...`) and appends each as a JSON line to
`<slot dir>/<box>/measurement.<id>.gpu.jsonl` on the box. The fields: `request_id` and `box` (the
registry's names), `hold_pid`, `event` (`opened` or `closed`), `at` (UTC), `probes` (one `{probe,
status, detail}` per source, `status` `ran`, `absent` or `failed`), `gpu_processes` (one `{pid,
user, command, probe}` per process and probe, plus `gpu_memory_mib` from nvidia-smi, or
`gpu_time_ns`, the client's cumulative GPU busy time as read, and from DRM `driver`), and
`own_tree_gpu_processes` (how many were left out as the hold's own). The sources, each read
exactly as `lib/ludics/fleetworker/cotenants.py`'s header states:

- **nvidia-smi** (CUDA boxes): `--query-compute-apps`, every user's CUDA contexts with their
  memory; a graphics-only client (Xorg, the compositor) is not a compute app and is not listed.
- **DRM fdinfo** (Linux, the AMD boxes' path): a process holding a `/dev/dri/*` descriptor, its
  driver and its `drm-engine-*` busy time from `/proc/<pid>/fdinfo`; only this user's processes
  are readable, so another user's (gdm's compositor, root's) are counted as unreadable in the
  probe's `detail`, not listed.
- **ioreg** (macOS): the `IOGPUDeviceUserClient`s (Apple Silicon's AGX clients) with their
  creator's pid and accumulated GPU time. Every app that ever drew holds one, so a snapshot
  lists dozens of mostly idle clients there.

It records PRESENCE, not usage: who was on the GPU at the two instants, with each probe's fields
as read. It does no before/after arithmetic; a reader comparing the two snapshots' cumulative
times does that themselves. The boundary in full is the module header's.

A conclusion of a measurement (`conclude <json>`, `--from-run` and `--from-bg-run` alike) reads that
file on the execution host and appends one clause to its evidence: `GPU co-tenants on <box>
(<box>:<path>): hold <pid> opened <at>: <n> [pid <pid> <user> <command> (<probe>, <measure>); ...];
closed <at>: ...`, one clause per hold, or `no GPU co-tenant
record on <box>` when no hold recorded one, or `GPU co-tenant record unread: <box> did not answer`.
A `not-launched` conclusion reads nothing. A hold still live when the conclusion reads the record
shows `its close is not recorded`, and the conclusion is final and does not wait, so conclude a
measurement once no process of it remains, as every conclusion requires. So "who held a fleet token" (`execution list --active`,
by `request_id` and `box`) and "who was on the GPU" (this record, by `box` and `at`) line up in a
conclusion's own evidence. Nothing is stopped: the record is evidence, a probe that fails says so in
`probes`, and a record that cannot be written is a `WARNING` with the snapshot still said on
stderr, never a refused measurement. A hold nested in a hold of the same measurement records its
own pair too, and is recorded only while it lives within its enclosing command. A conclusion reads the record's
newest MiB, and says so when the record is longer. `FLEET_NVIDIA_SMI`, `FLEET_DRM_PROC` and `FLEET_IOREG` name the
sources; the suites point them at stubs.

**Batching measurements into windows.** When a measurement request arrives for a box where workers
hold standing reservations, gather every pending measurement request for that box first (the
requests already queued, and any a worker has said is about to follow) and run them back to back
in arrival order: open a window with the first, and when its result line comes in, conclude it and
open the next one's window in the same turn. The conclusion restores the standing reservations and
the next window suspends them again, two registry calls with no message to the workers, whose
batches are refused naming whichever window is open. A request arriving while a window is open
joins the queue. The last conclusion leaves the standing reservations restored, and the workers'
batches are admitted again.

## The OS-level sleep guard

On native Linux the lab locks are advisory: they bind sessions that go through `wake-lab.sh`,
and nothing at the OS level stopped another session's `wake-lab.sh sleep`, or an idle suspend,
from taking a box out from under a running worker (under WSL the Windows-side holder did that).
So every run on a box carries a logind **block** inhibitor on `sleep:idle` for exactly as long
as it runs (ludics-lite#317): `execution slot` runs its command inside
`fleet-worker.sh execution hold [--why <text>] -- <command>`, and an exclusive measurement,
which takes no slot of its own, is invoked as `fleet-worker.sh execution hold --request
<request_id> -- <runner command>` (a slot its runner takes inside runs under that one guard:
[the measurement's own run](#exclusivity-and-the-run-time-slots)).
`hold` takes nothing else - no slot, no registry read, no lease - and where there is no
`systemd-inhibit` (macOS, a Linux host without systemd) it runs the command bare and silently.
The inhibitor is held by a helper BESIDE the command, not by systemd-inhibit wrapped around it:
the command inherits the slot flock and the helper's lifetime pipe with its exit status
unchanged, and the inhibitor lives exactly as long as the flock does - until the last process
of the command's tree exits, however it ends.
`FLEET_SYSTEMD_INHIBIT` names the binary; the suites point it at a stub.

**The command's process group, and `--deadline`** (ludics-lite#566). `hold` and `slot` run the
command as the leader of a process group (a session) of its own and stay its parent, so the
whole tree can be ended, not just its top: in the 2026-10-05 wave a hand-rolled `perl -e 'alarm
N; exec ...'` killed a driver script and left its benchmark child on the GPU for half an hour past
the window. `--deadline <seconds>` bounds the tree: when it passes, the group gets SIGTERM, then
SIGKILL once the leader and the rest are gone or 10 s have passed, and the wrapper exits **124**
with `EXECUTION HOLD|SLOT <box>: --deadline <n>s reached`; a command that ends first takes
anything it left running in its group with it. Without `--deadline` a command's leftovers run on,
holding the slot and the guard, as before. A SIGTERM, SIGINT, SIGHUP or SIGALRM to the wrapper
ends the group the same way and the wrapper then dies of that signal, so a harness's stop or a
Ctrl-C reaches the whole tree; a wrapper killed outright (`kill -9`) is answered by a guardian in a
session of its own, which kills the group at once. A nested `slot` (inside a held slot or a
measurement's own hold) takes no group of its own unless it has its own `--deadline`, so the
enclosing wrapper's group kill reaches everything it started. What leaves the group (a process
that calls `setsid` itself, a `bg-run.sh spawn` run) is not the wrapper's to end, and the command
has no controlling terminal, so a program that opens `/dev/tty` (a password prompt) finds none.

The mode is `block`, not `block-weak`: systemd 259's `systemctl --check-inhibitors=yes suspend`,
which is what `wake-lab.sh sleep` runs, refuses on any `block` inhibitor covering sleep, the
caller's own user included, while `block-weak` exempts the same user and so would not stop the
fleet's own `wake-lab.sh sleep` at all. logind itself also refuses a suspend request from anyone
without `suspend-ignore-inhibit` (auth_admin_keep on stock Ubuntu), which covers the GDM
greeter's power plugin on a box woken by WoL with nobody logged in.
`wake-lab.sh status` lists a native box's live sleep blocks (`sleep-blocks=<n>`, then one
`block:` line per holder), and a `sleep` refused by one names the holder and says `REFUSED`.

**Setup per native box.** An ssh session is a REMOTE subject to polkit, so
`org.freedesktop.login1.inhibit-block-sleep` falls under the action's `allow_any`, which stock
Ubuntu sets to `auth_admin_keep` (`allow_active` = yes covers only a local console session):
without a grant the request is denied ("Failed to inhibit: Access denied"), as it was on all
three boxes on 2026-09-23. The grant is `/etc/polkit-1/rules.d/50-fleet-inhibit.rules`, installed
by the Linux bootstrap, [`scripts/install-linux.md`](../../scripts/install-linux.md). Check it from an ssh session:
`pkcheck --action-id org.freedesktop.login1.inhibit-block-sleep --process $$; echo $?` prints 0.
On a box without it `hold` does not refuse the run - that would stop every batch there over a
setup step - but prints `EXECUTION HOLD <box>: WARNING: running WITHOUT a sleep inhibitor` with
the denial, and the run is unguarded.

Verified live on rog-nv-linux on 2026-09-23 (PR #323): with a `hold` running, `wake-lab.sh
status rog` showed `sleep-blocks=1` naming it, `wake-lab.sh sleep rog` printed `Operation
inhibited by "fleet-worker" ...` and `sleep REFUSED on rog by a block inhibitor` with exit 1,
the box stayed up, and `sleep-blocks` returned to 0 when the hold ended.

Idle suspend is off on the fleet's Ubuntu desktops without any site setting: Ubuntu's
`10_ubuntu-settings.gschema.override` sets `sleep-inactive-ac-timeout = 0` in a section with no
desktop qualifier, so it governs the GDM greeter as well as the logged-in session (upstream's
default is 900 seconds); `/etc/gdm3/greeter.dconf-defaults` leaves the power keys commented,
the greeter's dconf database carries none, and logind's `IdleAction` is `ignore`. Checked on
rog-nv-linux and minix-amd-linux on 2026-09-23 (both mini PCs without a battery; tuf, the one
laptop, adds battery and lid residue, in [linux-boxes.md](linux-boxes.md)). Recheck after a
release upgrade with `DCONF_PROFILE=/dev/null gsettings get
org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout` (0 is never); the inhibitor
is the guard either way, since logind refuses the greeter's suspend while it is held.

Use one canonical box name from the site's roster consistently (for example `rog-nv-linux`, not
an alternating ssh alias and app host ID). New reservations and dispatch require exact
`FLEET_BOXES` entries; aliases and case variants are refused. Configure one canonical entry per
physical box: ownership is keyed by the entry, so two aliases of one box would let a measurement
on one sit beside a run on the other. Reserve, run and dispatch refuse such a roster, naming both
entries and the box they share (ludics-lite#395). Which aliases are one box comes from
`wake-lab.sh endpoint-map`, the lab's `ENDPOINT_MAP` read as data, plus entries differing only by
case; ssh config aliases outside that map are not discovered. A checkout with no `wake-lab.sh`
prints an `EXECUTION WARNING` and checks exact entries only; one whose map is inconsistent refuses.
Outstanding records outside a changed roster block dispatch until reconciled; reads and
evidence/conclusion remain available under either refusal. Choose
placement using required hardware, current load, outstanding reservations and available warm
checkouts. Record the checkout actually used; this does not introduce persistent verifier
worktrees, sync, scheduling or remote agent launch.

`load` observes activity; reservations provide cooperative ownership. They do not stop
unrelated users or applications. The one scheduled sweep that reads them is OCANNL's daily
`tools/sweep.sh`, which skips a unit whose box an outstanding `measurement` names (on any of the
box's endpoints in `wake-lab.sh endpoint-map`) and defers to nothing else; it holds no reservation
and takes no slot itself (ahrefs/ocannl#1097). The other direction is the registry's (#445): a
`measurement` reserve, run or dispatch refuses a lab box whose lane lock a sweep lane holds, naming
the holder (`ocannl sweep <stamp> ...`), and holds that lock shared while it writes, so a lane that
starts after it reads the new record before its first unit. The lock is read in the anchor's own
lock directory, which is the lab's only on the machine that runs `wake-lab.sh` and the sweep, so
before reading it the check verifies that the anchor is that machine (#454): `FLEET_LAB_HOST`
(default `mac-studio`) must name the anchor, and the anchor must hold a readable wake-lab site
file. Otherwise the measurement is refused, naming both machines or the missing file, since a
lane elsewhere could not be seen. Move the anchor and the sweep together, and declare the new
machine. The destroyers (`wake-lab.sh restart-wsl`,
`--restart-wsl`, `sleep`, `hibernate`, `down`) likewise refuse a box an outstanding `measurement`
names, unless `--as=<request_id>` names it as the caller's own; an unreadable registry refuses them,
and `--force` skips the check. Correctness reservations take part in neither. Before timing
experiments inspect external activity and wait when it compromises the measurement. Existing
project runners continue to own process locks, time limits, cancellation and logs. This interface
never starts or stops a process.

## Reserve, launch, observe, conclude

The coordinator performs mutations; workers request with issue/purpose, requested revision,
execution host and workload kind. Persist JSON payloads on the board as evidence. A reservation
must exist before launch. For example `reserve.json`:

```json
{
  "request_id": "wave-issue123-cuda-1",
  "wave": "wave-20260912",
  "worker": "/root/issue123",
  "transport": "subagent",
  "issue": "owner/repo#123",
  "purpose": "bounded CUDA correctness verification",
  "agent_host": "mac-studio",
  "execution_host": "rog-nv-linux",
  "repository": "owner/repo",
  "requested_revision": "<full 40-hex pushed SHA (git rev-parse), or a ref>",
  "kind": "correctness"
}
```

`requested_revision` is free text: a pushed ref (`origin/main`), an exact SHA, or a SHA with a note
(`<sha> plus working diff`). Each whitespace-separated word of it made only of hex digits, seven or
more, is read as a commit and must be the full 40-hex SHA of a commit GitHub has in `repository`
(ludics-lite#561): an abbreviation is refused before GitHub is asked, and a SHA GitHub answers `No
commit found` for is refused naming it and the repository. A ref or prose is not read. Every commit
a payload names is checked this way, near side, before the anchor is asked, with this box's `gh`
(`gh api repos/<repository>/commits/<sha>`, bounded by `FLEET_GH_TIMEOUT`); a GitHub that does not
answer (network, 5xx, rate limit, credentials, a 404 that may be a private repository the token
cannot see) is `EXECUTION UNVERIFIED github.com: ...`, exit 4, and nothing is recorded. A retry
whose first call landed with its answer lost (a reservation under an existing request id, a
conclusion of a concluded record) is not checked again: the registry's own retry rule answers it.
The boundary is `lib/ludics/fleetworker/revision.py`'s header.

**A request that follows a branch** (ludics-lite#558). `"requested_revision": "head-of:<branch>"`
names no commit when the worker asks, so a request queued behind a halt or a busy box cannot go
stale (three SHA-keyed requests of the 2026-10-05 wave did, one twice, each re-pinned by hand). It
is resolved at ASSIGNMENT: `run`, `window` and `dispatch` ask GitHub for the branch's head in the
request's `repository` (`gh api repos/<repository>/git/ref/heads/<branch>`), hand the registry that
commit as `resolved_revision`, and print `EXECUTION RESOLVED <id>: head-of:<branch> is <sha> in
<repository>, read at assignment` on stderr. The record keeps `resolved_revision` beside the
request, which stays as it was asked, and in the dispatch's history entry, through to the
conclusion; a reconcile to `reserved` and a new dispatch resolve again. `reserve` records no commit.
The grammar is one branch name (`[A-Za-z0-9._/-]`, git's ref rules within that), refused at reserve
otherwise; a branch GitHub has no head for is refused (exit 1), a GitHub that does not answer is
`EXECUTION UNVERIFIED` (exit 4), and nothing is recorded either way. The assignment names the
resolved SHA, never the branch, and an [`execution leg`](#a-leg-on-another-box) of the request
refuses any other commit.

Run `fleet-worker.sh execution reserve <absolute-reserve.json>`, or - the usual shape -
`fleet-worker.sh execution run <absolute-reserve.json>`, which reserves and dispatches under one
lock and leaves the record `launching` (the payload may add `evidence` for the dispatch step).
`run` is not idempotent by design: a second `run` of a dispatched request is refused, because
the connection that dropped after the first may have started the runner; reconcile instead. A
conflicting request reports its current owner and changes nothing. Retrying identical request
identity and fields returns the existing reservation, including terminal state; a changed
request with that ID is refused. IDs that differ only by case collide and are refused,
including on case-sensitive hosts. Use a new ID for a genuinely new execution. `execution list`
prints all records, including history; it requires no coordinator identity. For routine
supervision use `execution list --active --compact`: `--active` excludes concluded records,
and `--compact` omits history and the lease token while retaining current ownership, request
and execution evidence fields. Both options are read-only and validate the entire ledger before
filtering; use the default full listing for history and reconciliation. The creating
coordinator and wave remain recorded after adoption. Transport is `subagent`, `app`, `cli` or
`coordinator`. Transport and `agent_host` are provenance; exclusivity depends on
`execution_host`, whether the agent is local or remote. Provider is not an ownership key. The
same issue may hold separate reservations on different boxes. Planned placement is a default
for iteration; agent capacity and issue dependency readiness remain coordinator decisions
outside this API.

For a reservation created with `reserve`, immediately before invoking the existing bounded
project runner use `execution dispatch` with
`{"request_id":"wave-issue123-cuda-1","evidence":"about to invoke project verifier"}`.
This rechecks the lease and halt under lock and changes `reserved` to `launching`. Nonzero means
no dispatch. This is a point-in-time gate, not atomic with the subsequent ssh or tool call.
Record the pending launch before making the call, and never repeat a launch because the
connection dropped. If adoption or halt occurs in that gap, reconciliation must account for the
possible execution.

`execution run` already performs dispatch; do not dispatch that reservation again. The assignment
must name its workload kind and command: **correctness** wraps the bounded project runner in
`execution slot`; an exclusively reserved **measurement** invokes the runner without that
wrapper (ludics-lite#309), under `fleet-worker.sh execution hold --request <request_id> --
<runner command>` alone, the OS-level sleep guard `slot` also runs inside (ludics-lite#317,
[below](#the-os-level-sleep-guard)). The slot refuses every batch beside an outstanding
measurement, which protects the measurement from concurrent correctness batches; the one it
admits is a batch inside that measurement's own `hold --request` (ludics-lite#480), so a runner
that takes the slot itself needs no opt-out there. The assignment names the request id in that
command. Direct invocation still uses the project's time limits, logs and
process ownership; it does not skip the reservation, dispatch or external-activity check.

**The execution host's skills checkout** (ludics-lite#362). Only `launch` and `preflight` ever
fast-forwarded a box's `~/ludics-lite`, so a box the fleet only executes on kept a stale one:
tuf-amd-linux sat at `0f7de3d`, without `execution hold`, where a lane wrapped in it would have
exited 2. So every successful `run` or `dispatch` ends with `fleet-worker.sh refresh <execution
host>`, the preflight's own freshness check alone, and prints its one line on stderr: `REFRESH OK
<box> skills=<sha> (already current)` or `(fast-forwarded from <sha>)`; `REFRESH FAILED` with the
reason (a divergent checkout is reported and left as it is, never reset; the fetch, and the wait for
a preflight or another refresh holding the checkout's lock, are each capped by
`FLEET_REFRESH_TIMEOUT`, 30 s); or `REFRESH UNREACHABLE` for a box that did not answer (wake it,
then run `fleet-worker.sh refresh <box>`). It runs after the dispatch, outside the registry lock, so a hanging fetch holds no lock and
a refused reservation never touches a box that is measuring for someone else. The record on stdout
and the exit status are the dispatch's, whatever the refresh reports; read its line before sending
the assignment, since a FAILED or UNREACHABLE host runs whatever skill text it already has.

Use `execution record` with the request ID, `state` (`running` or `uncertain`), and nonempty
`evidence`. This requires a dispatched reservation (`launching`, `running` or `uncertain`); use
explicit reconciliation for recovered prelaunch observations. Add `observed_sha` (exact Git
SHA), `remote_checkout`, `handle`, and `log` as known. ssh failure means uncertain execution,
not a terminal failure. Elapsed time, a returned turn and a worker hand-back do not free a box.
Record the requested revision separately from the observed SHA; the project's verifier
determines whether the source/configuration is acceptable.

Once runner evidence establishes completion and no process remains, `execution conclude` accepts:

```json
{
  "request_id": "wave-issue123-cuda-1",
  "evidence": "runner terminal record retrieved; process stopped",
  "observed_sha": "0123456789012345678901234567890123456789",
  "remote_checkout": "/home/user/project-worktrees/verify",
  "handle": "project-runner-session-123",
  "log": "/home/user/logs/verify-123.log",
  "verdict": "pass"
}
```

An `observed_sha` in a `dispatch`, `record`, `reconcile` or `conclude` payload must be a commit GitHub has in
the request's `repository` (ludics-lite#561: two standing conclusions in one wave recorded the right
prefix with a wrong tail, and a concluded record is immutable). A SHA GitHub does not have, or a
SHA-256 ID (GitHub hosts no SHA-256 repository), is refused before the anchor is asked. Rather than copy a SHA by hand, `execution
conclude <payload.json> --observed-from <checkout>` reads `git rev-parse HEAD` of that absolute
checkout on the reservation's execution host and records it as `observed_sha` (and as
`remote_checkout` when the payload names none), appending where it was read to the evidence; a
payload `observed_sha` that is not that HEAD is refused naming both. The SHA it reads is checked on
GitHub like any other, since the checkout named may be another repository's. Use it only while the
checkout's HEAD is still the revision that ran. A conclusion that names no `observed_sha` inherits
the record's, which is checked too (a record written before this check may hold a mistyped one). A retry of a conclusion that landed
with its answer lost reuses the SHA the record holds rather than the checkout's HEAD now, so it is
still the registry's harmless identical retry after the worktree has moved on or gone.

When the run went through OCANNL's `tools/test-run.sh` (or any runner leaving `exit`, `log`,
`wt` and `cmd` under a run directory), `fleet-worker.sh execution conclude --from-run <run-dir>
--request <id> --sha <sha> [--box <execution host>] [--evidence <text>]` composes that payload
itself: the verdict from `exit` (0 pass, 142 timeout, a signal code cancelled, anything else
fail), `log` and the checkout from the record, the handle `test-run:<run>`, and `--sha` as the
observed SHA, which the checkout must contain. A record from `test-run.sh` since
ocannl-staging#808 names its own source at launch, `head` and `dirty` (`git status --porcelain`,
empty when clean), both or neither: a `head` other than `--sha` is refused with both SHAs named,
and a nonempty `dirty` is refused with its path count, since a run over uncommitted edits is
evidence for no commit (conclude one deliberately with a JSON payload whose evidence says so).
A record with neither (an older run, or no checkout) concludes on `--sha` from the worker's
result line and says so in the evidence; one file without the other is malformed and refused.
A checkout whose head has moved on since is noted in the evidence. `--sha` is also checked on
GitHub in the request's repository, as every revision is (a box holds several repositories' runs,
and the checkout containing a SHA says nothing about which repository it is). It
refuses a record without a verdict and a run the checkout's own `tools/test-run.sh status` does
not call finished. The run directory is read on the reservation's execution host, resolved from
the registry when `--box` is omitted; the conclusion names the box it read, and the registry
refuses evidence read on any box but the reserved one.

When the run blocked under `bg-run.sh` instead (a `tools/machine-verify.sh` leg, a measurement
script: eleven hand-written conclusions in the 2026-09-25 wave, ludics-lite#405),
`fleet-worker.sh execution conclude --from-bg-run <run-dir> --request <id> --sha <sha> [--box
<box>] [--checkout <text>] [--evidence <text>]` composes the payload from the directory. Its `--sha`
must be a commit GitHub has in the request's repository; `--observed-from <checkout>` in its place
reads the checkout's HEAD on the execution host instead (and names that checkout unless `--checkout`
does). The
verdict comes from bg-run.sh's own `wait <dir> --within 0`, so the directory has one reader,
plus the runner's `exit:` sentinel when the log has one (a whole line `exit:
N` or `<name>: exit: N`, the last one winning; OCANNL's `test-run.sh` and `machine-verify.sh`
print one): the code is the sentinel when that is nonzero, else `rc`, so a pass needs both. Then
0 is pass, 124 or 142 timeout, a signal code (129, 130, 137, 143) cancelled, anything else fail.
`RUNNING`, `STARTING` and `DIED` are refused. A `DIED` task was killed before its
command returned, and bg-run.sh's header names a window in which the command can outlive it
unpublished, so check that no process of the run remains and conclude it by JSON (`cancelled`). The directory is read on `--box`, by default the reservation's
execution host. Name the box that drove the run when the leg went over ssh (a machine-verify trip
started on the agent host leaves its directory there). Because that box is legitimately not the
reserved one, this form carries no execution-host binding; the conclusion's `log` and `handle`
name the box read (`<box>:<path>`), and its evidence says which box drove the run. bg-run keeps no
checkout: `--checkout` names one and replaces any the record carries; without it, one already on
the record is kept, and otherwise the field says it was not recorded.

A run that died before it fetched any source (a self-ssh refusal, a trip whose far side never
started) ran no revision. It is not a verdict about one, so there is no `fail` without
`observed_sha`: conclude it `not-launched` with evidence naming the failure and its log. To retry
under the same request instead, `reconcile` it to `reserved` (the evidence establishing that
nothing ran and nothing runs) and dispatch again.

The actual verdict must be `pass`, `fail`, `timeout` or `cancelled`. A timeout/cancellation needs
runner evidence that its processes stopped. SHA, checkout and handle may already be in the record;
evidence and log are required in the conclusion. If reconciliation proves nothing launched, use
`not-launched` with evidence and a reconciliation log. Terminal records are immutable; an identical
conclusion retry is harmless. There is no expiry or automatic release. Never remove a checkout
while an outstanding record refers to it, or while a pending reservation could still be using it.

A coordinator's integration run (SKILL.md's integration loop) adds `"integration": true` to an
ordinary non-standing `correctness` request of transport `coordinator`; the registry refuses the
field on any other shape. Concluded `pass` or `fail` at an exact `observed_sha`, it is the verdict
`fleet-worker.sh gate` hands `pr-review.sh base` for a default branch without push CI
(ludics-lite#401); a correctness run without the field is a targeted batch and is never offered.

A loop run - the GPU integration loop's, or the cc loop's local run - is one call (ludics-lite#615):
`fleet-worker.sh execution tip-run <reserve.json> --checkout <dir> [--runs <dir>] [--cpu] --
<command...>`. Its request is the coordinator's non-standing `correctness` request whose
`requested_revision` is exactly one full SHA. It yields, reserving nothing, to anything
outstanding on the box but standing reservations (read again once its own is published); then it
runs `execution run`, starts nothing on a remote box whose skills checkout the refresh did not
bring current, checks the SHA out
detached in the clean checkout on the box (fetching only when it lacks it), and starts the command
there under `execution slot --bg <runs> --wait 0` (default `<runs>`: `tip-runs` in the state
directory, `~/.local/state/issue-wave` on the box unless `ISSUE_WAVE_STATE` names another), so it
takes a GPU token, unless `--cpu`, only if one is free at once.
It prints `TIP-RUN STARTED <id> <box> <sha> <dir>` with the record moved to `running`, or `TIP-RUN
NOT STARTED <id>: <why>` (exit 1) with anything it reserved concluded `not-launched`; exit 4 is an
outcome to reconcile. Conclude a started run with `conclude --from-bg-run <dir> --request <id>
--sha <sha>`. The rules it enforces are `lib/ludics/fleetworker/tiprun.py`'s header.

## A leg on another box

A correctness or measurement run on a box other than the worker's own was a script each worker
wrote again: refresh a worktree there at the exact commit, run the project's runner, maybe apply a
patch that must make it fail. `fleet-worker.sh execution leg` is that script, inside the
reservation (ludics-lite#558):

```
fleet-worker.sh execution leg --request <id> [--box <box>] --rev <sha|branch> \
  --checkout <checkout on the box> --worktree <worktree on the box> [--remote <name>] \
  [--control <patch>] [--cpu|--gpu] [--wait <s>] [--wait-window[=<s>]] [--deadline <s>] \
  -- <runner command...>
```

- **The reservation.** `--request` must name a dispatched record (`launching`, `running` or
  `uncertain`; a standing one counts), read from the registry with no coordinator identity; its
  execution host is the box (`--box`, if given, must be it). A correctness record's runs go under
  `execution slot` on that box, with the slot flags given here; a measurement's under `execution
  hold --request <id>`, which takes `--deadline` alone. A record holding a `resolved_revision`
  (a [`head-of:` request](#reserve-launch-observe-conclude)) refuses any `--rev` that comes to
  another commit.
- **The worktree.** `--checkout` is the project's checkout on the box and `--worktree` a linked
  worktree of it (paths absolute or `~/`): made with `git worktree add --detach` when the path does
  not exist, checked out `--detach` at the commit when it does, and refused when it is another
  repository's, the main checkout itself, or dirty, which a leg never overwrites. A full SHA the
  checkout has is used as it is; anything else is fetched from `--remote` (`origin`) into a private
  ref of the checkout and resolved there, never through `FETCH_HEAD`, which a linked worktree
  cannot see (the trap ahrefs/ocannl#1153 hit) and which two legs in one checkout would overwrite.
  `EXECUTION LEG <box>: created|refreshed <worktree> at <sha> ...; observed_sha=<sha>` on stderr is
  the worktree's `git rev-parse HEAD` before the runner starts.
- **The runner.** The command after `--` runs in the worktree with its words passed through
  untouched, stdin closed. Its status is the leg's, unchanged (a 125, a 128 or more included), and
  the last line on stdout is `execution-leg: exit: <status>`, the sentinel `conclude --from-bg-run`
  reads. Without that line nothing ran to an end: `EXECUTION LEG REFUSED ...` says why (exit 1, 2
  for usage, or the slot's own refusal status when it never started the runner), and `EXECUTION
  LEG UNREACHABLE <box>` (4) is a box that never answered or a connection that dropped, the runner
  perhaps started: look on the box before running it again.
- **The control.** `--control <patch>` (a file on the caller's box) must apply before anything runs.
  After a main run that passed it is applied, the runner runs again in the same slot and must fail,
  and the patch is reverted: the leg exits 0 when the control failed (1-127, but 124), 1 with
  `CONTROL PASSED` when it did not, and the control's own status when it was cut (124, 128+). A
  failed main run is the leg's status, and the control does not run.

The verb names no project's runner or layout. OCANNL's is `tools/test-run.sh`, which builds as it
runs and takes the slot itself inside the leg's (the [nested slot](#exclusivity-and-the-run-time-slots)):
`-- tools/test-run.sh run <alias>`, or `-- tools/test-run.sh bisect <good> <bad> <targets...>`
(ahrefs/ocannl#1225), which bisects where it is invoked, so the leg is how it reaches a GPU box,
and its 125 and its abort statuses come back as they left. Any other repository passes its own
command, building first if its runner does not (`-- sh -c 'make && make check'`, `--
scripts/test.sh unit`), with `--checkout` its clone on the box. A leg longer than a tool call runs
under `bg-run.sh spawn` on the caller's box and concludes with `conclude --from-bg-run <dir> --box
<that box> --observed-from <worktree>`. Do not wrap the leg itself in an `execution slot` on the
caller's box: the slot it needs is the execution host's, which it takes there.

## Standing iteration reservation

A worker's own targeted correctness batches on its agent host, and on its GPU home box
([below](#the-gpu-home-box)), do not each need a request. The
coordinator takes one `kind: correctness` reservation per worker at launch (`execution run`,
request id `<wave>-<issue>-<host>-iterate`, `"standing": true`, purpose naming the bounded
aliases and `-j` width) and names it in the brief; the worker then runs those batches through
the project runner without asking, blocks on each inside its turn, and reports every run
directory. The reservation is concluded at hand-back with `conclude --from-run` on the last
batch's record, or, with none to read, a JSON conclusion with `--observed-from <the worker's
worktree>` rather than a SHA copied from the report. Measurement, one-off cross-box legs and full suites still go through a request.

`"standing": true` is what exempts the record from the box's slot count, and it is explicit
rather than read off the `-iterate` id convention: a mistyped id must not silently escape the
cap, and `execution list` shows the exemption as a field. Only a correctness reservation may
carry it, and only as `true`. In exchange the worker wraps each batch in the run-time lock:

```
fleet-worker.sh execution slot --wait-window -- tools/test-run.sh run <alias> -j 4
```

which waits out a measurement window on the box (`--wait-window`, below), blocks until one of
the box's slots is free (`--wait`, default 600 seconds, then a refusal), runs the batch under it, and returns the batch's own status. The `-j 4` is mac-studio's
width. On a native GPU box, omit it for a GPU batch: an explicit `-j` wins over the per-slot
width `tools/test-run.sh` injects there (ahrefs/ocannl#1033), so `-j 4` would halve rog's `-j 8`.
A batch that holds no GPU adds `--cpu` before the `--`, which on rog-nv-linux lets it run beside
the two GPU batches instead of waiting for their tokens. The bare suites of a
repository whose runner is a plain script go through it the same way, one batch per call
(2026-09-15: the coordinator ended up granting this by message after sixteen
request/assign/report round-trips parked three workers idle between review rounds).

A measurement on a box where the worker holds one suspends that reservation for as long as it runs: the
coordinator opens it as a [measurement window](#exclusivity-and-the-run-time-slots), the record's
state is `suspended` meanwhile, and a batch on the box waits for the window under the brief's
`execution slot --wait-window` (or is refused naming it without that flag). A standing
reservation taken while a window is open is admitted suspended, and restored with the others.

### The GPU home box

By default the coordinator takes a second standing reservation at launch, beside the agent-host
one, on the task's GPU box whenever the plan homes the task there or names a GPU iteration leg
for it: one per such box, request id `<wave>-<issue>-<box>-iterate`, the agent host still the
worker's (ludics-lite#621). A GPU box that IS the agent host (a CLI worker resident there) takes
no second one: its agent-host reservation already has that id and covers the batches, run
locally. A request per GPU run cost ahrefs/ocannl#1240 three HIP round trips in wave-20261014
before the coordinator granted a standing one mid-task, while #1313 on tuf-amd-linux, holding one
from launch, iterated without the coordinator and still yielded to measurement windows. Read the
`REFRESH` line its `execution run` prints before the brief goes out, as for any assignment.

The brief names the reservation id, a far-side checkout that is the worker's to prepare (a
worktree of the box's clone, with the worker its one writer), and the batch's form, which moves
that checkout to the pushed SHA under test and takes the slot on that box, not the agent's:

```
ssh <box> 'cd <checkout> && git fetch -q origin && git checkout -q --detach <sha> &&
  fleet-worker.sh execution slot --wait-window -- <runner>'
```

A standing record carries no per-batch revision, so the `<sha>` in the command is what binds a
batch to the code it judged, and the worker reports it with the run. A GPU batch passes no `-j`
(above), so the box's GPU tokens (rog-nv-linux: 2) still bound it however many standing records
the box holds. A batch that can outlast the tool cap takes `--bg <parent>` the same way, with the
parent and `bg-run.sh wait <dir>` on that box too.

Each standing reservation is concluded at hand-back from its own box's last batch: its runner
record with `--from-run`, or its `bg-run.sh` directory with `--from-bg-run` (each read on the
reservation's execution host), or, with none to read, a JSON conclusion with `--observed-from
<the far-side checkout>`. The coordinator records the far-side checkout on the board and removes
it at close-out with the worker's local one, once that conclusion has landed. A measurement
there, and a one-off leg on a box the plan names no iteration for, still go through a request.

## Native handoffs

A Claude Code native worker cannot wait for a message mid-turn, so its handoff is turn-shaped:
the `EXECUTION_REQUEST` block ending a turn, `EXECUTION_ASSIGNED <id>` on resume by agent ID,
and one `EXECUTION_RESULT {json}` line ending the result turn, which `conclude --from-run`
consumes; the formats and the coordinator's side are in
[native-claude.md](native-claude.md#worker-channel). A Codex native worker keeps its turn open
and messages instead ([native-codex.md](native-codex.md#worker-channel)).

## CLI reservation handoff

A detached CLI worker has no message channel to the coordinator. Its self-contained brief names
absolute request and result paths under its worker state directory on its agent host. Before
fleet tests or experiments, it writes the requested revision, execution host, workload kind,
exact bounded command/batch, checkout and intended log path to the request file, prints
`EXECUTION_REQUEST <absolute-path>`, and ends its turn without starting that execution.

The coordinator observes the tracked `attach` exit, reads the file (over ssh when needed), and
confirms through `status` that the turn has ended: a Claude worker `IDLE`, a Codex exec exited.
Queue the request until the execution host is available. Reserve it with `transport: "cli"` and
the actual `agent_host`, then call `execution dispatch`. Only after successful dispatch, send the
continuation with `fleet-worker.sh unstick <agent-box> <worker> --message <brief-file>` (an
append to the idle Claude process, a resume of the Codex thread). The continuation names the
request ID, assigned command/batch, revision, checkout, log and result paths; it instructs the
worker to run only that assignment and return its actual runner handle, observed SHA, log and
terminal outcome in the result file, then end its turn again before additional fleet work.
Start a new tracked `attach` waiter and record the unstick/runner evidence on the board.

Dispatch preceding the unstick is a point-in-time gate just as it precedes an ssh runner call.
If the unstick fails or its outcome is unclear, retain ownership and reconcile whether anything
started; never blindly dispatch or unstick twice. When the result turn ends, verify actual runner
termination and conclude with its evidence before resuming ordinary implementation/review. An
`IDLE` or `DONE` turn carrying a request or a result is a handoff, not issue completion (SKILL.md,
Supervise: *A returned turn means the turn ended*). A new execution needs a new request and
reservation. CLI workers never mutate the coordinator lease or reservation registry themselves.

## Adoption and halt

Lease adoption fences stale coordinator mutations; outstanding records survive. Read them and
reconcile runtime, Git and runner evidence before reusing their boxes. `execution reconcile`
requires request ID, evidence and state `reserved`, `running` or `uncertain`. Only use `reserved`
when evidence proves no execution began or can still begin; it acknowledges the new lease for a
later dispatch. Otherwise preserve uncertainty or conclude with verified terminal evidence.
Recording and concluding existing executions remain available during a halt for reconciliation.
An open [measurement window](#exclusivity-and-the-run-time-slots) and its suspended reservations
survive adoption as they stand: the adopter reconciles the window's measurement like any other
record, and its conclusion restores the suspended reservations, during a halt too. A suspended
reservation itself is not reconciled - the window owns its state until then - though it may be
concluded.

A halt refuses ordinary reservations and dispatch. The one named regression-triage reservation
may include a nonempty `triage_reason` only while a halt is active; its dispatch is allowed
during the halt. Premarking ordinary reservations as future triage is refused. Each new halt
receives a unique ID. Repeating `halt` to update its reason preserves that ID, including after
coordinator adoption; only resume followed by a new halt changes it. A triage reservation is
bound to that halt and cannot dispatch after it ends or during a later halt; its box stays
reserved until reconciled. Only an outstanding triage reservation for the current halt blocks
its next triage reservation. This exception must correspond to the board's named triage worker,
not a general bypass for ordinary work.

Fixtures: `python3 issue-wave/scripts/test-fleet-execution.py` exercises actual temporary anchor
state and concurrent processes without ssh, accounts or hardware. For live validation reserve
one box, run one existing bounded verification command at a recorded SHA, retain the actual
handle/log/verdict and conclude. Lack of hardware access remains a validation gate, not evidence
of success. The bounded two-worker transport smoke is in [native-workers.md](native-workers.md#close-out-and-bounded-smoke).

## Bounded native Windows verification

Over ssh a `-win` box lands in cmd.exe, where `git --version` prints `.windows.` but a bare `bash`
is WSL's. Invoke Git Bash by path, as the driver below does, and have the script under test print
`uname -s` (`MINGW*`/`MSYS*`) and `git --version` (`.windows.`); for OCANNL keep
`tools/test-run.sh`'s record.

A dual-boot box in Ubuntu can be put into Windows first: `wake-lab.sh boot-windows
--as=<request_id> <box>` (from the anchor, under an exclusive `measurement` reservation on the box,
since the reboot ends everything running there; `--as` names that reservation, and any other
active one on the box refuses the reboot) reboots it into Windows for one boot and exits 0 only once its native Git
Bash answers; `wake-lab.sh boot-linux --as=<request_id> <box>` returns it, and `wake-lab.sh status <box>` then shows
`os=linux`. Exit 3 is `NEEDS A PERSON`: tell the user at once rather than retrying. The README's lab
section has the one-time sudoers grant each box needs. tuf is refused (no Wake-on-LAN).

Use `issue-wave/scripts/windows-driver.ps1` for a foreground Git Bash verifier on native
Windows. It extracts the corrected driver from the #671 verification evidence. For example:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:/tools/ludics-lite/issue-wave/scripts/windows-driver.ps1 `
  -ScriptPath C:/work/verify.sh -LogPath C:/evidence/run-123.log `
  -ErrorPath C:/evidence/run-123.err -CapSeconds 120
```

`BashPath` defaults to `C:/Program Files/Git/usr/bin/bash.exe`. Use a fresh pair of log paths
in an existing directory for every invocation. The driver prints its PID and cap, caches the
process handle before waiting, and on timeout calls `taskkill /PID <owned-pid> /T /F`.
The verifier must keep its child work in the foreground (wait for all children) and emit its
verdict as stdout's **last line**, after all output, then exit with that same status:

```bash
bash --noprofile --norc /c/work/check.sh
rc=$?
printf 'exit: %s\n' "$rc"
exit "$rc"
```

Do not let `set -e` skip verdict publication: capture the command's failure explicitly if
using it. The driver accepts only `exit: N` with N in 0..255, requires that record even when
Windows supplies a native exit code, and cross-checks the native code whenever non-null.
A null native code never implies success. It returns the recorded code, 124 for a confirmed
timeout cleanup, or 2 for incomplete/inconsistent evidence or runner errors. Logs remain for
inspection. An unconfirmed cleanup leaves the reservation uncertain; do not conclude it merely
from wrapper termination. This foreground runner does not supervise detached work or replace
the reservation protocol above.

Run `powershell -NoProfile -File issue-wave/scripts/test-windows-driver.ps1` (or `pwsh`) on
Windows. CI runs both engines, including a real inner Bash failure with the native exit accessor
forced to null, absent/trailing/stale verdicts, mismatched codes, and owned-tree timeout.
